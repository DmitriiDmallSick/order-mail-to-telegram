const { htmlToText } = require('html-to-text');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID_TEST;

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

function extractRealUrlFromTracker(url) {
  const rawUrl = String(url || '').replace(/&amp;/g, '&').trim();

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
    const found = headers.find((header) => String(header.name || '').toLowerCase() === target);

    if (!found) return '';

    if (Array.isArray(found.values)) {
      return String(found.values[0] || '');
    }

    return String(found.value || '');
  }

  if (headers && typeof headers === 'object') {
    const directKey = Object.keys(headers).find((key) => String(key).toLowerCase() === target);

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

function extractEmailInput(event) {
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    const message = event.messages[0];

    const headers = message.headers || message.details?.headers || [];
    const subject = getHeader(headers, 'Subject') || String(message.subject || message.details?.subject || '');
    const contentType = getHeader(headers, 'Content-Type') || String(message.content_type || message.contentType || '');

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

    const combined = [rawMessage, htmlFromFields, textFromFields].filter(Boolean).join('\n\n');

    const looksLikeHtml =
      combined.includes('<html') ||
      combined.includes('<body') ||
      combined.includes('<table') ||
      /text\/html/i.test(contentType);

    return {
      subject,
      html: looksLikeHtml ? combined : htmlFromFields,
      text: looksLikeHtml ? textFromFields : combined,
      raw: combined.slice(0, 50000),
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

  const decodedUrls = urls.map(extractRealUrlFromTracker).filter(Boolean);

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
  const sourceText = normalizeSpaces([subject, text, textFromHtml].filter(Boolean).join('\n\n'));

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
    order_url: orderUrl,
    raw_subject: subject || '',
  };
}

function buildOrderText(order) {
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

async function sendTelegramOrder(order) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: buildOrderText(order),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('Telegram send failed:', result);
    throw new Error('Telegram send failed');
  }

  return result;
}

module.exports.handler = async function (event) {
  try {
    console.log('Incoming event keys:', Object.keys(event || {}));

    if (event.httpMethod && event.httpMethod !== 'POST') {
      return jsonResponse(405, {
        ok: false,
        error: 'Method not allowed',
      });
    }

    const emailInput = extractEmailInput(event);

    console.log('Extracted email input:', {
      subject: emailInput.subject,
      html_length: emailInput.html.length,
      text_length: emailInput.text.length,
    });

    const order = parseOrderEmail(emailInput);

    console.log('Parsed order:', {
      order_number: order.order_number,
      name: order.name,
      phone: order.phone,
      customer_email: order.customer_email,
      total_price: order.total_price,
      delivery_text: order.delivery_text,
      order_url: order.order_url,
    });

    const tgResult = await sendTelegramOrder(order);

    return jsonResponse(200, {
      ok: true,
      type: 'email_order_lite',
      order_number: order.order_number,
      phone: order.phone,
      name: order.name,
      telegram_message_id: String(tgResult?.result?.message_id || ''),
    });
  } catch (error) {
    console.error('order-mail-to-telegram-lite failed:', error);

    return jsonResponse(500, {
      ok: false,
      error: 'Internal server error',
      message: error.message,
    });
  }
};
