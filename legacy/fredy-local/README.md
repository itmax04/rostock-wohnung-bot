# Fredy (локально, устарело)

Первая версия мониторинга: open-source [Fredy](https://github.com/orangecoding/fredy) 29.2.1 в Docker на Mac
с уведомлениями в тот же Telegram-бот. **Заменён облачным Worker** из этого репозитория (Mac не нужен,
есть WIRO/FIDES и проверка лимита Jobcenter). Контейнер остановлен (`docker compose stop`).

- `docker-compose.yml` — конфигурация (порт только `127.0.0.1:9998`).
- `db/`, `conf/` — **не в git**: в базе объявления и токен Telegram. Локальная копия лежит рядом, если нужна.
- Границы районов для фильтра Fredy — `../../data/rostock-bezirke.geojson`.

Запустить снова (не нужно в обычной работе): `docker compose up -d`, интерфейс http://localhost:9998.
Учти: Fredy и Worker будут слать дубли в один чат.
