const {
  Driver,
  getCredentialsFromEnv,
  TypedValues,
} = require('ydb-sdk');

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { htmlToText } = require('html-to-text');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID_TEST;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'insales_order_alerts';

const YDB_ENDPOINT = process.env.YDB_ENDPOINT;
const YDB_DATABASE = process.env.YDB_DATABASE;

const YMQ_QUEUE_URL = process.env.YMQ_QUEUE_URL;
const REMINDER_DELAY_SECONDS = Number(process.env.REMINDER_DELAY_SECONDS || 600);

const sqsClient = new SQSClient({
  region: process.env.AWS_REGION || 'ru-central1',
  endpoint: 'https://message-queue.api.cloud.yandex.net',
});

function quotedTableName() {
  return '`' + String(ORDERS_TABLE).replace(/`/g, '') + '`';
}

let ydbDriverPromise = null;

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function makeRequestId(orderNumber) {
  const safeOrder = String(orderNumber || '')
    .replace(/[^\dA-Za-zА-Яа-я_-]/g, '')
    .slice(0, 32);

  const suffix = Math.random().toString(36).slice(2, 8);

  if (safeOrder) {
    return `io_${safeOrder}_${Date.now()}_${suffix}`;
  }

  return `io_${Date.now()}_${suffix}`;
}

function normalizeSpaces(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHtml(html) {
  return htmlToText(String(html || ''), {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  });
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeSpaces(match[1]);
    }
  }

  return '';
}

function stripBracketLinks(value) {
  return String(value || '')
    .replace(/\s*\[https?:\/\/[^\]]+\]/gi, '')
    .replace(/\s*\[tel:[^\]]+\]/gi, '')
    .trim();
}

function decodeBase64Url(value) {
  try {
    let str = String(value || '')
      .replace(/~/g, '=')
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    while (str.length % 4) {
      str += '=';
    }

    return Buffer.from(str, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function extractRealUrlFromInsalesTracker(url) {
  const rawUrl = String(url || '')
    .replace(/&amp;/g, '&')
    .trim();

  if (!rawUrl) return '';

  try {
    const parsed = new URL(rawUrl);
    const encodedTarget = parsed.searchParams.get('url');

    if (!encodedTarget) {
      return rawUrl;
    }

    const decodedTarget = decodeBase64Url(encodedTarget);

    return decodedTarget || rawUrl;
  } catch (_) {
    return rawUrl;
  }
}

function cleanCustomerName(value) {
  return normalizeSpaces(
    String(value || '')
      .replace(/\s*E-mail\s*:.*$/i, '')
      .replace(/\s*Email\s*:.*$/i, '')
      .replace(/\s*Телефон\s*:.*$/i, '')
      .trim()
  );
}

function cleanComment(value) {
  return normalizeSpaces(
    stripBracketLinks(value)
      .replace(/\n?Интернет-магазин[\s\S]*$/i, '')
      .replace(/\n?Контактный телефон:[\s\S]*$/i, '')
      .replace(/\n?Сформировано с помощью[\s\S]*$/i, '')
      .replace(/\n?Ссылка:[\s\S]*$/i, '')
  );
}

function cleanProductLine(line) {
  return stripBracketLinks(line)
    .replace(/^\d{4,}\s+/, '')
    .trim();
}

function cleanDeliveryText(value) {
  return normalizeSpaces(
    stripBracketLinks(value)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^\d[\d\s.,]*\s*₽$/.test(line))
      .filter((line) => !/^https?:\/\//i.test(line))
      .join('\n')
  );
}

function extractDeliveryText(sourceText) {
  return cleanDeliveryText(matchFirst(sourceText, [
    /Способ получения:\s*([\s\S]*?)(?:\n\s*Способ оплаты:|\n\s*Оплата:|\n\s*Статус оплаты:|\n\s*Комментарий:|\n\s*Итого к оплате:|$)/i,
    /Способ доставки:\s*([\s\S]*?)(?:\n\s*Способ оплаты:|\n\s*Оплата:|\n\s*Статус оплаты:|\n\s*Комментарий:|\n\s*Итого к оплате:|$)/i,
    /Доставка:\s*([\s\S]*?)(?:\n\s*Способ оплаты:|\n\s*Оплата:|\n\s*Статус оплаты:|\n\s*Комментарий:|\n\s*Итого к оплате:|$)/i,
    /Адрес доставки:\s*([\s\S]*?)(?:\n\s*Способ оплаты:|\n\s*Оплата:|\n\s*Статус оплаты:|\n\s*Комментарий:|\n\s*Итого к оплате:|$)/i,
  ]));
}

function getHeader(headers, headerName) {
  const target = String(headerName || '').toLowerCase();

  if (Array.isArray(headers)) {
    const found = headers.find((header) => {
      return String(header.name || '').toLowerCase() === target;
    });

    if (!found) return '';

    if (Array.isArray(found.values)) {
      return String(found.values[0] || '');
    }

    return String(found.value || '');
  }

  if (headers && typeof headers === 'object') {
    const directKey = Object.keys(headers).find((key) => {
      return String(key).toLowerCase() === target;
    });

    if (!directKey) return '';

    const value = headers[directKey];

    if (Array.isArray(value)) {
      return String(value[0] || '');
    }

    return String(value || '');
  }

  return '';
}

function decodeMaybeBase64(value) {
  const str = String(value || '');

  if (!str) return '';

  try {
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(str) && str.length > 40) {
      const decoded = Buffer.from(str, 'base64').toString('utf8');

      if (
        decoded.includes('<html') ||
        decoded.includes('<body') ||
        decoded.includes('Поступил заказ') ||
        decoded.includes('Состав заказа') ||
        decoded.includes('Информация')
      ) {
        return decoded;
      }
    }
  } catch (_) {
    // ignore
  }

  return str;
}

function parseEventBody(event) {
  if (!event?.body) return null;

  let body = event.body;

  if (event.isBase64Encoded) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }

  if (typeof body === 'object' && body !== null) {
    return body;
  }

  try {
    return JSON.parse(String(body || '{}'));
  } catch (_) {
    return null;
  }
}

function getTelegramCallback(event) {
  const body = parseEventBody(event);

  if (body?.callback_query) {
    return body.callback_query;
  }

  if (event?.callback_query) {
    return event.callback_query;
  }

  return null;
}

function extractEmailInput(event) {
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    const message = event.messages[0];

    const headers = message.headers || message.details?.headers || [];
    const subject =
      getHeader(headers, 'Subject') ||
      String(message.subject || message.details?.subject || '');

    const contentType =
      getHeader(headers, 'Content-Type') ||
      String(message.content_type || message.contentType || '');

    const rawMessage = decodeMaybeBase64(
      message.message ||
      message.body ||
      message.text ||
      message.html ||
      message.details?.message ||
      message.details?.body ||
      ''
    );

    const htmlFromFields = decodeMaybeBase64(
      message.html ||
      message.body_html ||
      message.details?.html ||
      message.details?.body_html ||
      ''
    );

    const textFromFields = decodeMaybeBase64(
      message.text ||
      message.body_text ||
      message.details?.text ||
      message.details?.body_text ||
      ''
    );

    const combined = [rawMessage, htmlFromFields, textFromFields]
      .filter(Boolean)
      .join('\n\n');

    const looksLikeHtml =
      combined.includes('<html') ||
      combined.includes('<body') ||
      combined.includes('<table') ||
      /text\/html/i.test(contentType);

    return {
      subject,
      html: looksLikeHtml ? combined : htmlFromFields,
      text: looksLikeHtml ? textFromFields : combined,
      raw: JSON.stringify({
        received_at: message.received_at || message.event_metadata?.created_at || '',
        subject,
        content_type: contentType,
        message: combined.slice(0, 50000),
      }),
    };
  }

  const parsed = parseEventBody(event);

  if (parsed) {
    return {
      subject: String(parsed.subject || parsed.raw_subject || ''),
      html: String(parsed.html || parsed.body_html || ''),
      text: String(parsed.text || parsed.body_text || parsed.body || parsed.raw || ''),
      raw: JSON.stringify(parsed),
    };
  }

  let rawBody = event.body || '';

  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }

  rawBody = String(rawBody || '');

  return {
    subject: '',
    html: rawBody.includes('<html') || rawBody.includes('<body') ? rawBody : '',
    text: rawBody,
    raw: rawBody,
  };
}

function extractOrderUrl(html, sourceText) {
  const htmlString = String(html || '');
  const textString = String(sourceText || '');

  const urls = [];

  const hrefRegex = /href=["']([^"']+)["']/gi;
  let hrefMatch;

  while ((hrefMatch = hrefRegex.exec(htmlString)) !== null) {
    urls.push(hrefMatch[1]);
  }

  const textUrlRegex = /https?:\/\/[^\s<>"']+/gi;
  let textMatch;

  while ((textMatch = textUrlRegex.exec(textString)) !== null) {
    urls.push(textMatch[0]);
  }

  const decodedUrls = urls
    .map(extractRealUrlFromInsalesTracker)
    .filter(Boolean);

  const adminUrl = decodedUrls.find((url) => /\/admin\/orders\//i.test(url));
  if (adminUrl) return adminUrl;

  const orderUrl = decodedUrls.find((url) => /\/orders?\//i.test(url));
  if (orderUrl) return orderUrl;

  return '';
}

function extractProductsText(sourceText) {
  const block = matchFirst(sourceText, [
    /Состав заказа:\s*([\s\S]*?)(?:\n\s*Сумма:|\n\s*Способ получения:|\n\s*Способ доставки:|\n\s*Доставка:|\n\s*Адрес доставки:|\n\s*Способ оплаты:|\n\s*Итого к оплате:|$)/i,
    /Вы заказали:\s*([\s\S]*?)(?:\n\s*Сумма:|\n\s*Способ получения:|\n\s*Способ доставки:|\n\s*Доставка:|\n\s*Адрес доставки:|\n\s*Способ оплаты:|\n\s*Итого к оплате:|$)/i,
  ]);

  if (!block) {
    return '';
  }

  const lines = block
    .split('\n')
    .map((line) => cleanProductLine(line))
    .filter(Boolean)
    .filter((line) => !/^\d{4,}$/.test(line))
    .filter((line) => !/^цена:/i.test(line))
    .filter((line) => !/^кол-во:/i.test(line))
    .filter((line) => !/^количество:/i.test(line))
    .filter((line) => !/^\d[\d\s.,]*\s*₽$/.test(line))
    .filter((line) => !/^https?:\/\//i.test(line));

  return normalizeSpaces(lines.join('\n'));
}

function parseOrderEmail({ subject, html, text }) {
  const textFromHtml = html ? stripHtml(html) : '';
  const sourceText = normalizeSpaces(
    [subject, text, textFromHtml].filter(Boolean).join('\n\n')
  );

  const orderNumber = matchFirst(sourceText, [
    /Поступил заказ\s*№\s*([^\s\n]+)/i,
    /заказ\s*№\s*([^\s\n!]+)/i,
    /Благодарим Вас за заказ\s*№\s*([^\s\n!]+)/i,
    /Новый заказ\s*№\s*([^\s\n]+)/i,
  ]);

  const name = cleanCustomerName(matchFirst(sourceText, [
    /Информация\s+(?:по|о)\s+клиенту:[\s\S]*?Имя:\s*([\s\S]*?)(?:\s*E-mail:|\s*Email:|\s*Телефон:|\n)/i,
    /Имя:\s*([\s\S]*?)(?:\s*E-mail:|\s*Email:|\s*Телефон:|\n)/i,
    /Здравствуйте,\s*([^!\n]+)!/i,
  ]));

  const customerEmail = matchFirst(sourceText, [
    /E-mail:\s*([^\s\n]+)/i,
    /Email:\s*([^\s\n]+)/i,
    /Почта:\s*([^\s\n]+)/i,
  ]);

  const phone = matchFirst(sourceText, [
    /Телефон:\s*([+\d\s\-()]+)/i,
    /Тел\.?:\s*([+\d\s\-()]+)/i,
  ]);

  const totalPrice = matchFirst(sourceText, [
    /Итого к оплате:\s*([^\n]+)/i,
    /Сумма:\s*([^\n]+)/i,
  ]);

  const deliveryText = extractDeliveryText(sourceText);

  const paymentText = matchFirst(sourceText, [
    /Способ оплаты:\s*([^\n]+)/i,
  ]);

  const paymentStatus = matchFirst(sourceText, [
    /Статус оплаты:\s*([^\n]+)/i,
    /(Заказ уже оплачен)/i,
    /(Заказ ещё не оплачен)/i,
    /(Заказ еще не оплачен)/i,
  ]);

  const comment = cleanComment(matchFirst(sourceText, [
    /Комментарий:\s*([\s\S]*?)(?:\n\s*Интернет-магазин|\n\s*Контактный телефон:|\n\s*Сформировано с помощью|\n\s*Ссылка:|\n\s*Способ получения:|\n\s*Способ доставки:|\n\s*Доставка:|\n\s*Адрес доставки:|\n\s*Способ оплаты:|\n\s*Статус оплаты:|\n\s*Итого к оплате:|$)/i,
  ]));

  const productsText = extractProductsText(sourceText);
  const orderUrl = extractOrderUrl(html, sourceText);

  return {
    order_number: orderNumber,
    name,
    customer_email: customerEmail,
    phone,
    products_text: productsText,
    total_price: totalPrice,
    comment,
    delivery_text: deliveryText,
    payment_text: paymentText,
    payment_status: paymentStatus,
    order_url: orderUrl,
    raw_subject: subject || '',
    raw_email_text: sourceText.slice(0, 20000),
  };
}

async function getYdbDriver() {
  if (!ydbDriverPromise) {
    const driver = new Driver({
      endpoint: YDB_ENDPOINT,
      database: YDB_DATABASE,
      authService: getCredentialsFromEnv(),
    });

    ydbDriverPromise = driver.ready(10000).then(() => driver);
  }

  return ydbDriverPromise;
}

async function createOrderInYdb(order) {
  const driver = await getYdbDriver();

  await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;
      DECLARE $status AS Utf8;
      DECLARE $order_number AS Utf8;
      DECLARE $phone AS Utf8;
      DECLARE $name AS Utf8;
      DECLARE $customer_email AS Utf8;
      DECLARE $products_text AS Utf8;
      DECLARE $total_price AS Utf8;
      DECLARE $comment AS Utf8;
      DECLARE $delivery_text AS Utf8;
      DECLARE $payment_text AS Utf8;
      DECLARE $payment_status AS Utf8;
      DECLARE $order_url AS Utf8;
      DECLARE $message_id AS Utf8;
      DECLARE $created_at AS Utf8;
      DECLARE $accepted_by AS Utf8;
      DECLARE $accepted_at AS Utf8;
      DECLARE $raw_subject AS Utf8;
      DECLARE $raw_email_text AS Utf8;

      UPSERT INTO ${quotedTableName()} (
        request_id,
        status,
        order_number,
        phone,
        name,
        customer_email,
        products_text,
        total_price,
        comment,
        delivery_text,
        payment_text,
        payment_status,
        order_url,
        message_id,
        created_at,
        accepted_by,
        accepted_at,
        raw_subject,
        raw_email_text
      )
      VALUES (
        $request_id,
        $status,
        $order_number,
        $phone,
        $name,
        $customer_email,
        $products_text,
        $total_price,
        $comment,
        $delivery_text,
        $payment_text,
        $payment_status,
        $order_url,
        $message_id,
        $created_at,
        $accepted_by,
        $accepted_at,
        $raw_subject,
        $raw_email_text
      );
    `;

    const params = {
      $request_id: TypedValues.utf8(order.request_id),
      $status: TypedValues.utf8(order.status),
      $order_number: TypedValues.utf8(order.order_number || ''),
      $phone: TypedValues.utf8(order.phone || ''),
      $name: TypedValues.utf8(order.name || ''),
      $customer_email: TypedValues.utf8(order.customer_email || ''),
      $products_text: TypedValues.utf8(order.products_text || ''),
      $total_price: TypedValues.utf8(order.total_price || ''),
      $comment: TypedValues.utf8(order.comment || ''),
      $delivery_text: TypedValues.utf8(order.delivery_text || ''),
      $payment_text: TypedValues.utf8(order.payment_text || ''),
      $payment_status: TypedValues.utf8(order.payment_status || ''),
      $order_url: TypedValues.utf8(order.order_url || ''),
      $message_id: TypedValues.utf8(order.message_id || ''),
      $created_at: TypedValues.utf8(order.created_at),
      $accepted_by: TypedValues.utf8(order.accepted_by || ''),
      $accepted_at: TypedValues.utf8(order.accepted_at || ''),
      $raw_subject: TypedValues.utf8(order.raw_subject || ''),
      $raw_email_text: TypedValues.utf8(order.raw_email_text || ''),
    };

    await session.executeQuery(query, params);
  });
}

async function updateTelegramMessageId({ requestId, messageId }) {
  const driver = await getYdbDriver();

  await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;
      DECLARE $message_id AS Utf8;

      UPDATE ${quotedTableName()}
      SET message_id = $message_id
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
      $message_id: TypedValues.utf8(messageId || ''),
    };

    await session.executeQuery(query, params);
  });
}

async function getOrderFromYdb(requestId) {
  const driver = await getYdbDriver();

  return await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;

      SELECT
        request_id,
        status,
        order_number,
        phone,
        name,
        customer_email,
        products_text,
        total_price,
        comment,
        delivery_text,
        payment_text,
        order_url,
        message_id,
        accepted_by,
        accepted_at
      FROM ${quotedTableName()}
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
    };

    const result = await session.executeQuery(query, params);
    const rows = result.resultSets?.[0]?.rows || [];

    if (!rows.length) {
      return null;
    }

    const row = rows[0];

    return {
      request_id: row.items[0]?.textValue || '',
      status: row.items[1]?.textValue || '',
      order_number: row.items[2]?.textValue || '',
      phone: row.items[3]?.textValue || '',
      name: row.items[4]?.textValue || '',
      customer_email: row.items[5]?.textValue || '',
      products_text: row.items[6]?.textValue || '',
      total_price: row.items[7]?.textValue || '',
      comment: row.items[8]?.textValue || '',
      delivery_text: row.items[9]?.textValue || '',
      payment_text: row.items[10]?.textValue || '',
      order_url: row.items[11]?.textValue || '',
      message_id: row.items[12]?.textValue || '',
      accepted_by: row.items[13]?.textValue || '',
      accepted_at: row.items[14]?.textValue || '',
    };
  });
}

async function markOrderAccepted({ requestId, acceptedBy, acceptedAt }) {
  const driver = await getYdbDriver();

  await driver.tableClient.withSession(async (session) => {
    const query = `
      DECLARE $request_id AS Utf8;
      DECLARE $status AS Utf8;
      DECLARE $accepted_by AS Utf8;
      DECLARE $accepted_at AS Utf8;

      UPDATE ${quotedTableName()}
      SET
        status = $status,
        accepted_by = $accepted_by,
        accepted_at = $accepted_at
      WHERE request_id = $request_id;
    `;

    const params = {
      $request_id: TypedValues.utf8(requestId),
      $status: TypedValues.utf8('accepted'),
      $accepted_by: TypedValues.utf8(acceptedBy),
      $accepted_at: TypedValues.utf8(acceptedAt),
    };

    await session.executeQuery(query, params);
  });
}

function buildOrderText(order, options = {}) {
  const isReminder = options.isReminder === true;

  if (isReminder) {
    const lines = [
      '🚨 <b>Заказ не принят 10 минут</b>',
      '',
      `<b>Заказ:</b> ${escapeHtml(order.order_number ? `№${order.order_number}` : 'номер не найден')}`,
      '',
      `<b>Клиент:</b> ${escapeHtml(order.name || 'не указан')}`,
      `<b>Телефон:</b> <code>${escapeHtml(order.phone || 'не найден')}</code>`,
    ];

    if (order.customer_email) {
      lines.push(`<b>E-mail:</b> <code>${escapeHtml(order.customer_email)}</code>`);
    }

    if (order.order_url) {
      lines.push('', `<a href="${escapeHtml(order.order_url)}">Открыть заказ в админке</a>`);
    }

    return lines.join('\n');
  }

  const lines = [
    '🛒 <b>Новый заказ!</b>',
    '',
    `<b>Заказ:</b> ${escapeHtml(order.order_number ? `№${order.order_number}` : 'номер не найден')}`,
    '',
    `<b>Клиент:</b> ${escapeHtml(order.name || 'не указан')}`,
    `<b>Телефон:</b> <code>${escapeHtml(order.phone || 'не найден')}</code>`,
  ];

  if (order.customer_email) {
    lines.push(`<b>E-mail:</b> <code>${escapeHtml(order.customer_email)}</code>`);
  }

  lines.push('');

  if (order.products_text) {
    lines.push('<b>Состав заказа:</b>');
    lines.push(escapeHtml(order.products_text));
    lines.push('');
  }

  if (order.total_price) {
    lines.push(`<b>Сумма:</b> ${escapeHtml(order.total_price)}`);
  }

  if (order.delivery_text) {
    lines.push('', '<b>Доставка:</b>', escapeHtml(order.delivery_text));
  }

  if (order.payment_text) {
    lines.push('', `<b>Оплата:</b> ${escapeHtml(order.payment_text)}`);
  }

  if (order.comment) {
    lines.push('', '<b>Комментарий:</b>', escapeHtml(order.comment));
  }

  if (order.order_url) {
    lines.push('', `<a href="${escapeHtml(order.order_url)}">Открыть заказ в админке</a>`);
  }

  return lines.join('\n');
}

function buildAcceptedText(order, acceptedBy) {
  const lines = [
    '✅ <b>Заказ принят</b>',
    '',
    `<b>Заказ:</b> ${escapeHtml(order.order_number ? `№${order.order_number}` : order.request_id)}`,
    `<b>Принял:</b> ${escapeHtml(acceptedBy)}`,
  ];

  if (order.phone) {
    lines.push(`<b>Телефон:</b> <code>${escapeHtml(order.phone)}</code>`);
  }

  if (order.order_url) {
    lines.push('', `<a href="${escapeHtml(order.order_url)}">Открыть заказ в админке</a>`);
  }

  return lines.join('\n');
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(`Telegram ${method} failed:`, result);
    throw new Error(`Telegram ${method} failed`);
  }

  return result;
}

async function sendTelegramOrder(order, options = {}) {
  const isReminder = options.isReminder === true;
  const text = buildOrderText(order, options);

  const payload = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };

  if (!isReminder) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: '✅ Принять заказ',
            callback_data: `accept:${order.request_id}`,
          },
        ],
      ],
    };
  }

  const result = await telegramApi('sendMessage', payload);

  return result;
}

async function sendReminderToQueue(requestId) {
  if (!YMQ_QUEUE_URL) {
    throw new Error('YMQ_QUEUE_URL is not set');
  }

  const command = new SendMessageCommand({
    QueueUrl: YMQ_QUEUE_URL,
    DelaySeconds: REMINDER_DELAY_SECONDS,
    MessageBody: JSON.stringify({
      request_id: requestId,
    }),
  });

  await sqsClient.send(command);
}

function getAcceptedBy(callback) {
  const user = callback.from || {};

  if (user.username) {
    return `@${user.username}`;
  }

  return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'неизвестно';
}

async function answerCallback(callbackId, text) {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: false,
  });
}

async function makeButtonAccepted({ chatId, messageId, acceptedBy }) {
  if (!chatId || !messageId) return;

  await telegramApi('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `✅ Принято: ${acceptedBy}`,
            callback_data: 'already_accepted',
          },
        ],
      ],
    },
  });
}

async function handleTelegramCallback(callback) {
  const data = String(callback.data || '');

  if (data === 'already_accepted') {
    await answerCallback(callback.id, 'Этот заказ уже принят ✅');

    return jsonResponse(200, {
      ok: true,
      type: 'telegram_callback',
      ignored: true,
      reason: 'already_accepted_button',
    });
  }

  if (!data.startsWith('accept:')) {
    return jsonResponse(200, {
      ok: true,
      type: 'telegram_callback',
      ignored: true,
      reason: 'unknown_callback_data',
    });
  }

  const requestId = data.replace('accept:', '').trim();

  if (!requestId) {
    await answerCallback(callback.id, 'Ошибка: нет ID заказа');

    return jsonResponse(200, {
      ok: false,
      error: 'empty_request_id',
    });
  }

  const order = await getOrderFromYdb(requestId);

  if (!order) {
    await answerCallback(callback.id, 'Заказ не найден');

    return jsonResponse(200, {
      ok: false,
      error: 'order_not_found',
      request_id: requestId,
    });
  }

  const chatId = callback.message?.chat?.id || CHAT_ID;
  const clickedMessageId = callback.message?.message_id;

  if (order.status === 'accepted') {
    const acceptedBy = order.accepted_by || 'кто-то';

    await answerCallback(callback.id, `Уже принято: ${acceptedBy}`);

    await makeButtonAccepted({
      chatId,
      messageId: clickedMessageId,
      acceptedBy,
    });

    return jsonResponse(200, {
      ok: true,
      type: 'telegram_callback',
      request_id: requestId,
      status: 'already_accepted',
      accepted_by: acceptedBy,
    });
  }

  const acceptedBy = getAcceptedBy(callback);
  const acceptedAt = new Date().toISOString();

  await markOrderAccepted({
    requestId,
    acceptedBy,
    acceptedAt,
  });

  await answerCallback(callback.id, 'Заказ принят ✅');

  await makeButtonAccepted({
    chatId,
    messageId: clickedMessageId,
    acceptedBy,
  });

  if (order.message_id && String(order.message_id) !== String(clickedMessageId)) {
    await makeButtonAccepted({
      chatId: CHAT_ID,
      messageId: order.message_id,
      acceptedBy,
    }).catch((error) => {
      console.error('Failed to update original order button:', error.message);
    });
  }

  await telegramApi('sendMessage', {
    chat_id: chatId || CHAT_ID,
    text: buildAcceptedText(order, acceptedBy),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return jsonResponse(200, {
    ok: true,
    type: 'telegram_callback',
    request_id: requestId,
    status: 'accepted',
    accepted_by: acceptedBy,
    accepted_at: acceptedAt,
  });
}

function extractRequestIdsFromQueueEvent(event) {
  const requestIds = [];

  const messages = event.messages || [];

  for (const message of messages) {
    try {
      const bodyRaw =
        message.details?.message?.body ||
        message.details?.body ||
        message.body ||
        '';

      if (!bodyRaw) continue;

      const body = typeof bodyRaw === 'string' ? JSON.parse(bodyRaw) : bodyRaw;

      if (body.request_id) {
        requestIds.push(String(body.request_id));
      }
    } catch (error) {
      console.error('Failed to parse queue message:', error.message);
    }
  }

  const body = parseEventBody(event);

  if (body?.request_id) {
    requestIds.push(String(body.request_id));
  }

  if (event.request_id) {
    requestIds.push(String(event.request_id));
  }

  return [...new Set(requestIds)];
}

async function handleReminderEvent(requestIds) {
  for (const requestId of requestIds) {
    const order = await getOrderFromYdb(requestId);

    if (!order) {
      console.error('Reminder order not found:', requestId);
      continue;
    }

    if (order.status === 'pending') {
      await sendTelegramOrder(order, {
        isReminder: true,
      });
    } else {
      console.log('Order already accepted, skip reminder:', {
        request_id: requestId,
        status: order.status,
        accepted_by: order.accepted_by,
      });
    }
  }

  return jsonResponse(200, {
    ok: true,
    type: 'reminder',
    processed: requestIds.length,
  });
}

async function handleEmailOrder(event) {
  const emailInput = extractEmailInput(event);

  console.log('Extracted email input:', {
    subject: emailInput.subject,
    html_length: emailInput.html.length,
    text_length: emailInput.text.length,
  });

  const parsedOrder = parseOrderEmail(emailInput);

  console.log('Parsed order:', {
    order_number: parsedOrder.order_number,
    name: parsedOrder.name,
    phone: parsedOrder.phone,
    customer_email: parsedOrder.customer_email,
    total_price: parsedOrder.total_price,
    delivery_text: parsedOrder.delivery_text,
    order_url: parsedOrder.order_url,
  });

  const requestId = makeRequestId(parsedOrder.order_number);
  const createdAt = new Date().toISOString();

  const order = {
    request_id: requestId,
    status: 'pending',
    message_id: '',
    created_at: createdAt,
    accepted_by: '',
    accepted_at: '',
    ...parsedOrder,
  };

  await createOrderInYdb(order);

  const tgResult = await sendTelegramOrder(order);
  const messageId = String(tgResult?.result?.message_id || '');

  await updateTelegramMessageId({
    requestId,
    messageId,
  });

  await sendReminderToQueue(requestId);

  return jsonResponse(200, {
    ok: true,
    type: 'email_order',
    request_id: requestId,
    order_number: order.order_number,
    phone: order.phone,
    name: order.name,
    telegram_message_id: messageId,
    reminder_delay_seconds: REMINDER_DELAY_SECONDS,
  });
}

module.exports.handler = async function (event) {
  try {
    console.log('Incoming event keys:', Object.keys(event || {}));

    const callback = getTelegramCallback(event);

    if (callback) {
      console.log('Route: telegram callback');
      return await handleTelegramCallback(callback);
    }

    const requestIds = extractRequestIdsFromQueueEvent(event);

    if (requestIds.length > 0) {
      console.log('Route: reminder queue', requestIds);
      return await handleReminderEvent(requestIds);
    }

    if (event.httpMethod && event.httpMethod !== 'POST') {
      return jsonResponse(405, {
        ok: false,
        error: 'Method not allowed',
      });
    }

    console.log('Route: email order');
    return await handleEmailOrder(event);
  } catch (error) {
    console.error('insales-order-handler failed:', error);

    return jsonResponse(500, {
      ok: false,
      error: 'Internal server error',
      message: error.message,
    });
  }
};
