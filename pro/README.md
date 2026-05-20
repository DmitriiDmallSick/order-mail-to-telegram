[README.md](https://github.com/user-attachments/files/28046241/README.md)
# Pro version

Полная версия: получает email-уведомление о заказе, отправляет заказ в Telegram, сохраняет статус в YDB, обрабатывает кнопку «Принять заказ» и отправляет напоминание через YMQ, если заказ не принят.

## Файлы

```text
pro/
├─ index.js
└─ package.json
```

## Переменные окружения

См. `examples/env.pro.example`.

## Таблица YDB

SQL лежит в `docs/ydb-table.sql`.

## Инструкция по установке

См. `main/README.md`.
