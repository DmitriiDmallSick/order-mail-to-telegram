# Разбор `index.js`

Техническая карта файлов:

```text
lite/index.js — простая версия: email → Telegram
pro/index.js  — полная версия: email → Telegram + YDB + Telegram callback + YMQ reminder
```

---

# 1. Общий принцип

Обе версии работают вокруг одного входа:

```js
module.exports.handler = async function (event) {
  ...
}
```

Это точка входа Cloud Function:

```text
index.handler
```

---

# 2. Lite: структура `lite/index.js`

Lite-версия делает только один сценарий:

```text
входящее письмо → парсинг заказа → сообщение в Telegram
```

Основной поток:

```js
module.exports.handler
  → extractEmailInput(event)
  → parseOrderEmail(emailInput)
  → sendTelegramOrder(order)
```

---

## 2.1. Переменные Lite

```js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID_TEST;
```

Используются:

```text
TELEGRAM_BOT_TOKEN — токен Telegram-бота
TELEGRAM_CHAT_ID — рабочий чат
TELEGRAM_CHAT_ID_TEST — тестовый чат, fallback
```

---

## 2.2. Входная функция Lite

```js
module.exports.handler = async function (event) {
  ...
}
```

Что делает:

```text
1. Проверяет HTTP-метод, если функция вызвана как HTTP
2. Достаёт письмо через extractEmailInput
3. Парсит заказ через parseOrderEmail
4. Отправляет заказ в Telegram через sendTelegramOrder
5. Возвращает JSON-ответ
```

Ключевые логи:

```text
Incoming event keys:
Extracted email input:
Parsed order:
order-mail-to-telegram-lite failed:
```

---

# 3. Pro: структура `pro/index.js`

Pro-версия обрабатывает три сценария в одном `handler`:

```text
1. Email Trigger — новый заказ
2. Telegram webhook — клик по кнопке
3. YMQ Trigger — напоминание
```

Основной роутинг:

```js
module.exports.handler = async function (event) {
  const callback = getTelegramCallback(event);

  if (callback) {
    return await handleTelegramCallback(callback);
  }

  const requestIds = extractRequestIdsFromQueueEvent(event);

  if (requestIds.length > 0) {
    return await handleReminderEvent(requestIds);
  }

  return await handleEmailOrder(event);
}
```

---

## 3.1. Переменные Pro

```js
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID_TEST;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'insales_order_alerts';

const YDB_ENDPOINT = process.env.YDB_ENDPOINT;
const YDB_DATABASE = process.env.YDB_DATABASE;

const YMQ_QUEUE_URL = process.env.YMQ_QUEUE_URL;
const REMINDER_DELAY_SECONDS = Number(process.env.REMINDER_DELAY_SECONDS || 600);
```

Используются:

```text
TELEGRAM_BOT_TOKEN — токен Telegram-бота
TELEGRAM_CHAT_ID — рабочий чат
TELEGRAM_CHAT_ID_TEST — тестовый чат, fallback

YDB_ENDPOINT — endpoint YDB
YDB_DATABASE — путь к базе YDB
ORDERS_TABLE — таблица заказов

YMQ_QUEUE_URL — URL очереди YMQ
AWS_ACCESS_KEY_ID — ключ доступа для YMQ
AWS_SECRET_ACCESS_KEY — секретный ключ для YMQ
AWS_REGION — регион, обычно ru-central1

REMINDER_DELAY_SECONDS — задержка напоминания в секундах
```

---

## 3.2. Безопасное имя таблицы

В Pro есть функция:

```js
function quotedTableName() {
  return '`' + String(ORDERS_TABLE).replace(/`/g, '') + '`';
}
```

Она нужна, чтобы использовать имя таблицы из переменной окружения:

```env
ORDERS_TABLE=insales_order_alerts
```

Если переменная не задана, используется:

```text
insales_order_alerts
```

---

# 4. Общие helper-функции

Эти функции есть в Lite и Pro.

---

## 4.1. `jsonResponse`

```js
function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  };
}
```

Формирует HTTP-ответ функции.

---

## 4.2. `escapeHtml`

```js
function escapeHtml(value) {
  ...
}
```

Экранирует символы для Telegram HTML mode:

```text
&
<
>
```

Используется перед вставкой пользовательских данных в Telegram-сообщение.

---

## 4.3. `normalizeSpaces`

```js
function normalizeSpaces(value) {
  ...
}
```

Чистит текст:

```text
неразрывные пробелы
лишние пробелы
лишние пустые строки
пробелы вокруг переносов
```

---

## 4.4. `stripHtml`

```js
function stripHtml(html) {
  return htmlToText(String(html || ''), {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
    ],
  });
}
```

Преобразует HTML письма в текст.

Важная настройка:

```js
{ selector: 'a', options: { ignoreHref: true } }
```

Она не даёт `html-to-text` добавлять длинные ссылки в текст товара.

---

## 4.5. `matchFirst`

```js
function matchFirst(text, patterns) {
  ...
}
```

Принимает текст и массив регулярных выражений.  
Возвращает первое найденное значение.

Используется почти во всём парсинге:

```text
номер заказа
имя
email
телефон
сумма
оплата
комментарий
```

---

## 4.6. `stripBracketLinks`

```js
function stripBracketLinks(value) {
  ...
}
```

Удаляет мусорные ссылки вида:

```text
[https://...]
[tel:+79999999999]
```

---

## 4.7. `decodeBase64Url`

```js
function decodeBase64Url(value) {
  ...
}
```

Декодирует base64url-строку.

Используется для извлечения реальной ссылки из tracking URL.

---

# 5. Извлечение реальной ссылки

## Lite

```js
function extractRealUrlFromTracker(url) {
  ...
}
```

## Pro

```js
function extractRealUrlFromInsalesTracker(url) {
  ...
}
```

Обе функции делают одно и то же:

```text
1. Получают URL
2. Проверяют query-параметр url
3. Декодируют его
4. Возвращают реальную ссылку, если она найдена
```

Нужно для ссылок вида:

```text
https://orders.insales.com/ru/go2_link_tracker?...&url=...
```

---

# 6. Очистка клиентских данных

## 6.1. `cleanCustomerName`

```js
function cleanCustomerName(value) {
  ...
}
```

Убирает из имени клиента случайно прилипшие поля:

```text
E-mail:
Email:
Телефон:
```

---

## 6.2. `cleanComment`

```js
function cleanComment(value) {
  ...
}
```

Очищает комментарий от служебного хвоста письма.

Удаляет блоки после:

```text
Интернет-магазин
Контактный телефон:
Сформировано с помощью
Ссылка:
```

---

## 6.3. `cleanProductLine`

```js
function cleanProductLine(line) {
  ...
}
```

Чистит строку товара:

```text
убирает ссылки
убирает артикул в начале строки
```

Пример:

```text
00019 Перкуссионный массажер Booster M2
```

превращается в:

```text
Перкуссионный массажер Booster M2
```

---

## 6.4. `cleanDeliveryText`

```js
function cleanDeliveryText(value) {
  ...
}
```

Чистит доставку:

```text
убирает ссылки
убирает пустые строки
убирает одиночные суммы
```

---

# 7. Извлечение email из события

```js
function extractEmailInput(event) {
  ...
}
```

Возвращает:

```js
{
  subject,
  html,
  text,
  raw
}
```

Обрабатывает три варианта входа:

```text
1. Yandex Email Trigger через event.messages
2. Ручной JSON-тест через event.body
3. Сырой body как HTML или текст
```

---

## 7.1. `getHeader`

```js
function getHeader(headers, headerName) {
  ...
}
```

Достаёт заголовки письма:

```text
Subject
Content-Type
```

Поддерживает оба формата:

```text
массив headers
объект headers
```

---

## 7.2. `decodeMaybeBase64`

```js
function decodeMaybeBase64(value) {
  ...
}
```

Пытается декодировать base64.

Декодированный текст принимается только если похож на письмо:

```text
<html
<body
Поступил заказ
Состав заказа
Информация
```

---

## 7.3. `parseEventBody`

```js
function parseEventBody(event) {
  ...
}
```

Используется для HTTP/webhook-событий.

Делает:

```text
декодирует base64 body
парсит JSON
возвращает объект или null
```

В Pro дополнительно используется для Telegram webhook и YMQ fallback.

---

# 8. Парсинг заказа

Главная функция:

```js
function parseOrderEmail({ subject, html, text }) {
  ...
}
```

Возвращает объект:

```js
{
  order_number,
  name,
  customer_email,
  phone,
  products_text,
  total_price,
  comment,
  delivery_text,
  payment_text,
  payment_status, // только Pro
  order_url,
  raw_subject,
  raw_email_text // только Pro
}
```

В Lite нет `payment_status` и `raw_email_text`.

---

## 8.1. Номер заказа

Ищется через:

```js
const orderNumber = matchFirst(sourceText, [
  /Поступил заказ\s*№\s*([^\s\n]+)/i,
  /заказ\s*№\s*([^\s\n!]+)/i,
  /Благодарим Вас за заказ\s*№\s*([^\s\n!]+)/i,
  /Новый заказ\s*№\s*([^\s\n]+)/i,
]);
```

Менять тут, если в письмах другой формат номера.

---

## 8.2. Имя клиента

```js
const name = cleanCustomerName(matchFirst(sourceText, [
  ...
]));
```

Ищет:

```text
Имя:
Здравствуйте, ...
```

---

## 8.3. Email клиента

```js
const customerEmail = matchFirst(sourceText, [
  /E-mail:\s*([^\s\n]+)/i,
  /Email:\s*([^\s\n]+)/i,
  /Почта:\s*([^\s\n]+)/i,
]);
```

---

## 8.4. Телефон

```js
const phone = matchFirst(sourceText, [
  /Телефон:\s*([+\d\s\-()]+)/i,
  /Тел\.?:\s*([+\d\s\-()]+)/i,
]);
```

---

## 8.5. Сумма

```js
const totalPrice = matchFirst(sourceText, [
  /Итого к оплате:\s*([^\n]+)/i,
  /Сумма:\s*([^\n]+)/i,
]);
```

---

## 8.6. Оплата

```js
const paymentText = matchFirst(sourceText, [
  /Способ оплаты:\s*([^\n]+)/i,
]);
```

В Pro дополнительно есть:

```js
const paymentStatus = matchFirst(sourceText, [
  /Статус оплаты:\s*([^\n]+)/i,
  /(Заказ уже оплачен)/i,
  /(Заказ ещё не оплачен)/i,
  /(Заказ еще не оплачен)/i,
]);
```

`paymentStatus` сохраняется в YDB, но в Telegram-сообщении сейчас не выводится.

---

# 9. Состав заказа

```js
function extractProductsText(sourceText) {
  ...
}
```

Ищет блок:

```text
Состав заказа:
```

или:

```text
Вы заказали:
```

Останавливается перед:

```text
Сумма:
Способ получения:
Способ доставки:
Доставка:
Адрес доставки:
Способ оплаты:
Итого к оплате:
```

Фильтрует:

```text
артикулы
строки цены
строки количества
одиночные суммы
ссылки
```

Менять эту функцию, если товары в письме оформлены иначе.

---

# 10. Доставка

```js
function extractDeliveryText(sourceText) {
  ...
}
```

Ищет:

```text
Способ получения:
Способ доставки:
Доставка:
Адрес доставки:
```

Менять тут, если в письме другие названия секций.

---

# 11. Ссылка на заказ

```js
function extractOrderUrl(html, sourceText) {
  ...
}
```

Ищет все URL в:

```text
HTML href
обычном тексте
```

Потом пытается выбрать:

```text
/admin/orders/...
/orders/...
```

Главная строка выбора админки:

```js
const adminUrl = decodedUrls.find((url) => /\/admin\/orders\//i.test(url));
```

---

# 12. Формирование Telegram-сообщения

```js
function buildOrderText(order, options = {}) {
  ...
}
```

В Lite принимает только `order`.

В Pro принимает ещё `options`.

---

## 12.1. Обычное сообщение

Выводит:

```text
Новый заказ
номер заказа
клиент
телефон
email
состав заказа
сумма
доставка
оплата
комментарий
ссылка на админку
```

---

## 12.2. Reminder-сообщение Pro

В Pro, если:

```js
options.isReminder === true
```

формируется короткий текст:

```text
Заказ не принят 10 минут
номер заказа
клиент
телефон
email
ссылка на админку
```

В reminder не выводятся:

```text
состав заказа
сумма
доставка
оплата
комментарий
кнопка принятия
```

---

## 12.3. Сообщение после принятия Pro

```js
function buildAcceptedText(order, acceptedBy) {
  ...
}
```

Формирует сообщение:

```text
Заказ принят
Заказ: №...
Принял: @username
Телефон: ...
Открыть заказ в админке
```

---

# 13. Telegram API

## Lite

```js
async function sendTelegramOrder(order) {
  ...
}
```

Сразу вызывает:

```text
sendMessage
```

Без кнопок.

---

## Pro

```js
async function telegramApi(method, payload) {
  ...
}
```

Универсальная функция для Telegram API.

Используется для:

```text
sendMessage
answerCallbackQuery
editMessageReplyMarkup
```

---

## 13.1. Отправка заказа в Pro

```js
async function sendTelegramOrder(order, options = {}) {
  ...
}
```

Если это обычный заказ, добавляет кнопку:

```js
reply_markup: {
  inline_keyboard: [
    [
      {
        text: '✅ Принять заказ',
        callback_data: `accept:${order.request_id}`,
      },
    ],
  ],
}
```

Если это reminder:

```js
isReminder === true
```

кнопка не добавляется.

---

# 14. Pro: YDB

Lite не использует YDB.

---

## 14.1. Подключение к YDB

```js
async function getYdbDriver() {
  ...
}
```

Создаёт и кеширует YDB driver:

```js
let ydbDriverPromise = null;
```

---

## 14.2. Создание заказа

```js
async function createOrderInYdb(order) {
  ...
}
```

Делает `UPSERT` в таблицу.

Новый заказ создаётся со статусом:

```text
pending
```

---

## 14.3. Сохранение Telegram message_id

```js
async function updateTelegramMessageId({ requestId, messageId }) {
  ...
}
```

Сохраняет `message_id` первого Telegram-сообщения.

Нужно для изменения кнопки.

---

## 14.4. Получение заказа

```js
async function getOrderFromYdb(requestId) {
  ...
}
```

Используется в двух местах:

```text
при клике на кнопку
при reminder-событии
```

---

## 14.5. Принятие заказа

```js
async function markOrderAccepted({ requestId, acceptedBy, acceptedAt }) {
  ...
}
```

Обновляет:

```text
status = accepted
accepted_by
accepted_at
```

---

# 15. Pro: кнопка “Принять заказ”

---

## 15.1. Получение callback

```js
function getTelegramCallback(event) {
  ...
}
```

Ищет:

```js
callback_query
```

в теле webhook-события.

---

## 15.2. Обработка callback

```js
async function handleTelegramCallback(callback) {
  ...
}
```

Основной сценарий:

```text
1. Проверить callback_data
2. Достать request_id
3. Найти заказ в YDB
4. Если уже accepted — ответить “Уже принято”
5. Если pending — обновить статус
6. Ответить Telegram callback
7. Изменить кнопку
8. Отправить сообщение “Заказ принят”
```

---

## 15.3. Кто нажал кнопку

```js
function getAcceptedBy(callback) {
  ...
}
```

Если есть username:

```text
@username
```

Если username нет:

```text
first_name last_name
```

---

## 15.4. Ответ на callback

```js
async function answerCallback(callbackId, text) {
  ...
}
```

Показывает короткое уведомление пользователю в Telegram.

Примеры:

```text
Заказ принят ✅
Уже принято: @username
Этот заказ уже принят ✅
```

---

## 15.5. Изменение кнопки

```js
async function makeButtonAccepted({ chatId, messageId, acceptedBy }) {
  ...
}
```

Меняет кнопку на:

```text
✅ Принято: @username
```

Через Telegram API:

```text
editMessageReplyMarkup
```

---

# 16. Pro: YMQ reminder

Lite не использует YMQ.

---

## 16.1. Отправка в очередь

```js
async function sendReminderToQueue(requestId) {
  ...
}
```

Отправляет в YMQ:

```json
{
  "request_id": "io_..."
}
```

С задержкой:

```js
DelaySeconds: REMINDER_DELAY_SECONDS
```

---

## 16.2. Извлечение request_id из события очереди

```js
function extractRequestIdsFromQueueEvent(event) {
  ...
}
```

Ищет `request_id` в:

```text
message.details.message.body
message.details.body
message.body
event.body
event.request_id
```

Возвращает массив уникальных `request_id`.

---

## 16.3. Обработка reminder

```js
async function handleReminderEvent(requestIds) {
  ...
}
```

Для каждого `request_id`:

```text
1. Получить заказ из YDB
2. Если заказа нет — лог Reminder order not found
3. Если status = pending — отправить reminder
4. Если status != pending — пропустить
```

Если заказ уже принят, лог:

```text
Order already accepted, skip reminder:
```

---

# 17. Pro: обработка нового заказа

```js
async function handleEmailOrder(event) {
  ...
}
```

Делает полный сценарий нового заказа:

```text
1. extractEmailInput
2. parseOrderEmail
3. makeRequestId
4. собрать объект order
5. createOrderInYdb
6. sendTelegramOrder
7. updateTelegramMessageId
8. sendReminderToQueue
```

---

# 18. Pro: request_id

```js
function makeRequestId(orderNumber) {
  ...
}
```

Создаёт внутренний ID заявки.

Формат примерно:

```text
io_6004_1710000000000_ab12cd
```

Используется:

```text
в YDB
в callback_data Telegram-кнопки
в YMQ-сообщении
```

---

# 19. Основные логи

## Lite

```text
Incoming event keys:
Extracted email input:
Parsed order:
order-mail-to-telegram-lite failed:
```

## Pro

```text
Incoming event keys:
Route: email order
Route: telegram callback
Route: reminder queue
Extracted email input:
Parsed order:
Failed to parse queue message:
Reminder order not found:
Order already accepted, skip reminder:
insales-order-handler failed:
```

---

# 20. Что менять под себя

Чаще всего нужно менять только эти функции:

```text
parseOrderEmail
extractProductsText
extractDeliveryText
extractOrderUrl
cleanComment
buildOrderText
buildAcceptedText
```

---

## 20.1. Если не находится номер заказа

Править регулярные выражения внутри:

```js
parseOrderEmail
```

---

## 20.2. Если не находится телефон

Править:

```js
const phone = matchFirst(sourceText, [
  ...
]);
```

---

## 20.3. Если не находится email

Править:

```js
const customerEmail = matchFirst(sourceText, [
  ...
]);
```

---

## 20.4. Если не находится состав заказа

Править:

```js
extractProductsText(sourceText)
```

---

## 20.5. Если не находится доставка

Править:

```js
extractDeliveryText(sourceText)
```

---

## 20.6. Если не находится ссылка на админку

Править:

```js
extractOrderUrl(html, sourceText)
```

---

## 20.7. Если нужно поменять Telegram-сообщение

Править:

```js
buildOrderText(order, options)
```

В Pro дополнительно:

```js
buildAcceptedText(order, acceptedBy)
```

---

# 21. Что лучше не трогать без необходимости

В Pro лучше не менять без причины:

```text
getYdbDriver
createOrderInYdb
updateTelegramMessageId
getOrderFromYdb
markOrderAccepted
sendReminderToQueue
handleTelegramCallback
handleReminderEvent
module.exports.handler
```

Это инфраструктурная часть:

```text
YDB
YMQ
Telegram callback
роутинг событий
статусы
```

---

# 22. Быстрая карта функций

## Lite

```text
jsonResponse                 — HTTP JSON-ответ
escapeHtml                   — экранирование HTML для Telegram
normalizeSpaces              — чистка пробелов
stripHtml                    — HTML → текст
matchFirst                   — первый regex match
stripBracketLinks            — удаление ссылок [https://...]
decodeBase64Url              — base64url decode
extractRealUrlFromTracker    — разворачивание tracking URL
cleanCustomerName            — чистка имени
cleanComment                 — чистка комментария
cleanProductLine             — чистка строки товара
cleanDeliveryText            — чистка доставки
extractDeliveryText          — парсинг доставки
getHeader                    — чтение заголовков email
decodeMaybeBase64            — декодирование base64
parseEventBody               — чтение event.body
extractEmailInput            — получение subject/html/text
extractOrderUrl              — поиск ссылки на заказ
extractProductsText          — парсинг состава заказа
parseOrderEmail              — главный парсер заказа
buildOrderText               — текст Telegram-сообщения
sendTelegramOrder            — отправка в Telegram
module.exports.handler       — вход Cloud Function
```

---

## Pro

```text
quotedTableName              — безопасное имя таблицы
jsonResponse                 — HTTP JSON-ответ
escapeHtml                   — экранирование HTML для Telegram
makeRequestId                — внутренний request_id
normalizeSpaces              — чистка пробелов
stripHtml                    — HTML → текст
matchFirst                   — первый regex match
stripBracketLinks            — удаление ссылок [https://...]
decodeBase64Url              — base64url decode
extractRealUrlFromInsalesTracker — разворачивание tracking URL
cleanCustomerName            — чистка имени
cleanComment                 — чистка комментария
cleanProductLine             — чистка строки товара
cleanDeliveryText            — чистка доставки
extractDeliveryText          — парсинг доставки
getHeader                    — чтение заголовков email
decodeMaybeBase64            — декодирование base64
parseEventBody               — чтение event.body
getTelegramCallback          — поиск Telegram callback_query
extractEmailInput            — получение subject/html/text
extractOrderUrl              — поиск ссылки на заказ
extractProductsText          — парсинг состава заказа
parseOrderEmail              — главный парсер заказа
getYdbDriver                 — подключение к YDB
createOrderInYdb             — запись заказа в YDB
updateTelegramMessageId      — сохранение message_id
getOrderFromYdb              — получение заказа из YDB
markOrderAccepted            — статус accepted
buildOrderText               — текст заказа / reminder
buildAcceptedText            — текст “Заказ принят”
telegramApi                  — запросы к Telegram API
sendTelegramOrder            — отправка заказа / reminder
sendReminderToQueue          — постановка reminder в YMQ
getAcceptedBy                — имя менеджера
answerCallback               — ответ на callback
makeButtonAccepted           — изменение кнопки
handleTelegramCallback       — обработка кнопки
extractRequestIdsFromQueueEvent — request_id из YMQ
handleReminderEvent          — обработка reminder
handleEmailOrder             — обработка нового заказа
module.exports.handler       — вход Cloud Function и роутинг
```
