# Rostock Wohnung Bot

> **TL;DR (EN):** Cloudflare Worker that checks rental listings in Rostock (Germany) every 10 minutes, 24/7,
> keeps only flats within the Jobcenter rent limit (Bruttokaltmiete ≤ 481.80 €), and sends them to a private
> Telegram bot with one-tap letter templates and status tracking. Plain JavaScript (ES modules), no build step,
> state in Cloudflare KV. Docs below are in Russian; code comments are in Russian too.

Бот ищет квартиру для одного человека, которому аренду оплачивает **Hanse-Jobcenter Rostock**: каждые 10 минут
проверяет порталы, отбирает квартиры в пределах лимита Jobcenter и присылает их в Telegram с готовым письмом
арендодателю и кнопками статусов.

- **Работает:** Cloudflare Workers (бесплатный тариф), 24/7, без сервера и без Mac.
- **Telegram:** отдельный приватный бот владельца, отвечает только на `TELEGRAM_CHAT_ID`.
- **Стек:** JavaScript (ES-модули), без сборки и зависимостей; `wrangler` запускается через `npx`.

---

## Содержание

1. [Что делает бот](#что-делает-бот)
2. [Как это устроено](#как-это-устроено)
3. [Карта файлов: где что менять](#карта-файлов-где-что-менять)
4. [Источники объявлений](#источники-объявлений)
5. [Отбор и оценки](#отбор-и-оценки)
6. [Telegram: сообщения, кнопки, команды](#telegram-сообщения-кнопки-команды)
7. [Хранилище (KV)](#хранилище-kv)
8. [Запуск, проверка, публикация](#запуск-проверка-публикация)
9. [Секреты](#секреты)
10. [Эксплуатация и неполадки](#эксплуатация-и-неполадки)
11. [Ограничения и принятые решения](#ограничения-и-принятые-решения)

---

## Что делает бот

| Функция | Как |
|---|---|
| Мониторинг 24/7 | ImmoScout24, Kleinanzeigen, WIRO, FIDES, Neue Rostocker — по расписанию Cloudflare Cron |
| Главный критерий | **Bruttokaltmiete (Kaltmiete + Nebenkosten без отопления) ≤ 481,80 €** — норматив Hanse-Jobcenter Rostock для 1 человека (таблица города от 01.01.2024) |
| Точные Nebenkosten | для новых объявлений ImmoScout24 бот открывает карточку (exposé) и берёт реальные NK, отопление, Gesamtmiete, залог, год постройки |
| Приоритет | ⭐⭐ 2 комнаты в основном районе приходят первыми (на отбор не влияет) |
| Письмо арендодателю | кнопка «✍️ Письмо» → короткий нейтральный текст на немецком, адаптированный под квартиру (копируется одним нажатием) |
| Учёт откликов | кнопки ✉️ Написал → 💬 Ответил → 📅 Просмотр, ❌ Не подходит |
| Отчёт | каждый день в 21:00 (Берлин): найдено, отклики, ответы, просмотры, «без ответа > 3 дней», здоровье источников |
| Контроль сбоев | ⚠️ после 2 ошибок подряд у источника, ⚠️ если ImmoScout24/Kleinanzeigen 3 часа отдают 0 объявлений, ✅ при восстановлении |

Бот **не отправляет** письма арендодателям сам — только готовит текст (см. [решения](#ограничения-и-принятые-решения)).

## Как это устроено

```
Cloudflare Cron (UTC)
 ├─ */10 * * * *      → ImmoScout24 (+ ежедневный отчёт в 21:00 Берлина)
 ├─ 3-59/10 * * * *   → Kleinanzeigen
 └─ 6-59/10 * * * *   → WIRO, FIDES, Neue Rostocker (последний — только раз в час, в :06)
        │
        ▼
 runSource(key)  [src/index.js]
   1. source.fetch()               — скачать объявления           [src/sources.js]
   2. rejectReason(listing)        — цена/стоп-слова/город         [src/filters.js]
   3. source.enrich(listing)       — только новые, ≤6 за запуск    [ImmoScout24 exposé]
   4. sendListing + кнопки         — Telegram                       [src/telegram.js, src/store.js]
   5. matches:<src>, state:<src>   — KV                              [src/store.js]

 Telegram → POST /telegram (webhook) → handleUpdate()  [src/commands.js]
   команды /all /stats /profile /help, кнопки статусов и «✍️ Письмо» [src/letters.js]
```

**Почему источники разнесены по разным cron:** на бесплатном тарифе у каждого запуска лимит **10 мс CPU**.
Разбор одной страницы Kleinanzeigen занимает ~6–11 мс, поэтому каждый тяжёлый источник получает свой запуск.

## Карта файлов: где что менять

```
src/
  index.js      расписание (CRON_TO_SOURCES), основной цикл runSource, отчёт, HTTP-маршруты
  config.js     ВСЕ настройки отбора: лимит Jobcenter, стоп-слова, районы приоритета, индексы Ростока
  sources.js    источники: ImmoScout24 (fetch + enrich), Kleinanzeigen, WIRO, Neue Rostocker, FIDES
  filters.js    rejectReason, оценка 🟢/🟡/🔴, отопление против нормы, приоритет ⭐, признаки обмана
  districts.js  СГЕНЕРИРОВАН из data/rostock-bezirke.geojson (npm run districts) — руками не править
  store.js      KV matches:<src>, статусы, кнопки под объявлением
  letters.js    письмо арендодателю, профиль /profile
  commands.js   команды и кнопки Telegram, итоги дня (activitySummary)
  telegram.js   обёртка Bot API
scripts/
  check.js           локальный прогон всех источников и фильтров (без Telegram и KV)
  build_districts.py генератор src/districts.js
data/
  rostock-bezirke.geojson  границы 12 районов (OSM admin_level=10)
legacy/fredy-local/  старая локальная установка Fredy (Docker) — не используется, см. её README
wrangler.toml   имя Worker, cron, привязка KV, observability
```

| Хочу… | Где |
|---|---|
| поменять лимит аренды / оценку NK | `src/config.js` → `SEARCH`, `JOBCENTER` |
| добавить стоп-слово | `src/config.js` → `BLACKLIST` |
| поменять «основные районы» для ⭐ | `src/config.js` → `PRIORITY_DISTRICTS` (+ `data/*.geojson` и `npm run districts`, если нужен новый полигон) |
| добавить источник | `src/sources.js` (функция + запись в `SOURCES`), `src/store.js` → `sourceKeyOf`, `src/index.js` → `CRON_TO_SOURCES` |
| поменять текст письма | `src/letters.js` → `buildLetter` |
| поменять формат сообщения | `src/index.js` → `formatListing` |
| поменять команды/кнопки | `src/commands.js`, `src/store.js` → `listingKeyboard` |

## Источники объявлений

| Ключ | Сайт | Как читаем | Особенности |
|---|---|---|---|
| `immoscout` | ImmoScout24 | мобильный API `POST api.mobile.immobilienscout24.de/search/list`, детали — `GET /expose/{id}` | тот же API, что использует open-source Fredy; в выдаче только Kaltmiete — NK берутся из exposé |
| `kleinanzeigen` | Kleinanzeigen | HTML страницы поиска, разбор строковыми операциями (`data-adid`, JSON-LD) | бывают разовые 403 → один повтор через 5 с; NK ищутся в описании |
| `wiro` | WIRO (городская компания) | `POST wohnungssuche.wiro.de/wp-admin/admin-ajax.php` `action=res_filter_properties` с `nonce` со страницы | обычно почти пусто: WIRO раздаёт квартиры через «Wohnungswunsch»; цена — общая сумма |
| `neuerostocker` | Neue Rostocker WG | HTML `wohnungsangebote.html` (TYPO3) | **отвечает 403 на запросы из Cloudflare** → проверяется раз в час, в отчёте помечен ⛔ |
| `fides` | FIDES (Dierkow, Groß Klein, Schmarl) | HTML `wohnungssuche` + счётчик «Derzeit sind N freie Wohnungen» | карточку проверить было не на чем (всегда 0); если N>0, а разбор не удался — сообщение «у FIDES N квартир» |

Не подключены сознательно: **Immowelt** (защита DataDome), см. [решения](#ограничения-и-принятые-решения).

## Отбор и оценки

`rejectReason()` в `src/filters.js`, порядок:
1. **Стоп-слова** (`BLACKLIST`): жильё для монтажников, обмен квартир, WG, «на месяц», залы и т.п.
2. **Цена < 100 €** — посуточная аренда или ошибка.
3. **Порог Jobcenter:**
   - Kalt и NK известны → `Kalt + NK ≤ 481,80`;
   - известна только сумма с отоплением (WIRO или «NK включают отопление») → `≤ 560,80` (481,80 + ~79 € отопления для 45 м²);
   - NK неизвестны → отбор с оптимистичной оценкой 1,8 €/м² (чтобы не потерять квартиру с низкими NK), в сообщении — обычная оценка 2,3 €/м² и 🟡;
   - для ImmoScout24 до загрузки exposé проверяется только Kaltmiete (`lenient`), решение — по реальным NK.
4. **Только город Росток** по почтовому индексу (`ROSTOCK_ZIPS`): Kleinanzeigen подмешивает пригороды.

Пометки в сообщении: 🟢/🟡/🔴 по Bruttokalt, ✅/⚠️ отопление против нормы (м² × Bundesheizspiegel 2023 / 12),
⚠️ признаки обмана (`SCAM_WORDS`, < 5 €/м²), ⭐ приоритет.

**Нормативы Jobcenter** (проверено 16.10.2026): город публикует таблицу от 01.01.2024 — 481,80 € Bruttokalt
для 1 человека. Методика города: максимальная сумма WoGG для Mietenstufe III + 10 %. С 01.01.2025 сумма WoGG
выросла до 456 € → по методике выходило бы **501,60 €**, но город это не подтвердил. Владелец запросил ответ
у Jobcenter; при подтверждении поменять `SEARCH.bruttokaltLimit`.

## Telegram: сообщения, кнопки, команды

Под каждой квартирой:
```
[ ✍️ Письмо ]      [ 🔗 Открыть ]
[ ✉️ Написал ]     [ 💬 Ответил ]
[ 📅 Просмотр ]    [ ❌ Не подходит ]
```
Повторное нажатие статуса отменяет его (шаг назад по воронке). «✍️ Письмо» присылает текст в `<pre>`
(копируется нажатием) + перевод.

| Команда | Что делает |
|---|---|
| `/all` («все») | актуальные квартиры, ⭐⭐ первыми; скрыты снятые с публикации и ❌ |
| `/stats` («стат») | итоги за 24 ч + последняя проверка каждого источника |
| `/profile Имя; возраст; телефон; дополнительно` | подпись для писем (сохраняется в KV `profile`); возраст и телефон необязательны |
| `/help` | подсказка |

Служебные HTTP-адреса Worker (`https://rostock-wohnung-bot.<subdomain>.workers.dev`):

| Адрес | Назначение |
|---|---|
| `POST /telegram` | webhook Telegram; проверяется заголовок `X-Telegram-Bot-Api-Secret-Token == WEBHOOK_SECRET` |
| `GET /setup?key=RUN_KEY` | зарегистрировать webhook и меню команд (после смены команд или токена) |
| `GET /run?key=RUN_KEY&source=<ключ>` | ручной запуск источника (`immoscout`, `kleinanzeigen`, `wiro`, `neuerostocker`, `fides`; без `source` — все) |
| `GET /run?key=RUN_KEY&source=report` | отправить отчёт дня сейчас |
| `GET /run?key=RUN_KEY&source=resend` | заново прислать актуальные квартиры с текущими кнопками (после смены кнопок) |

## Хранилище (KV)

Привязка `STATE` (namespace id в `wrangler.toml`). Ключи:

| Ключ | Что | Кто пишет |
|---|---|---|
| `state:<источник>` | здоровье (`failCount`, `lastOkAt`, `lastError`, `zeroSince`), `active` (подходящие объявления, видимые сейчас), `rejected` (отклонённые после exposé, кэш 24 ч), `stats` (для отчёта) | каждый запуск источника |
| `matches:<источник>` | присланные квартиры: данные, `status`, `events` (время каждого статуса), `msgId` | при отправке и по кнопкам |
| `profile` | подпись для писем `{name, age, phone, extra}` | `/profile` |

«Уже присылали» = id есть в `matches:<источник>`. Поэтому при смене фильтров подходящие теперь объявления придут.
Записи старше 90 дней удаляются.

## Запуск, проверка, публикация

Нужно: Node.js ≥ 20, аккаунт Cloudflare (вход: `npx wrangler login`).

```bash
npm run check                 # все источники и фильтры локально, ничего не отправляет
node scripts/check.js wiro    # один источник
npm run deploy                # опубликовать (wrangler deploy)
npm run tail                  # живые логи и cpuTime каждого запуска
```

Проверка после изменения:
1. `npm run check` — нет ошибок разбора, отбор разумный.
2. `npm run deploy`.
3. `npm run tail` и дождаться запусков: `outcome: ok`, `cpuTime` по возможности ≤ 10 мс.
4. При необходимости — `GET /run?key=…&source=…` для немедленной проверки.

Новые cron-расписания начинают срабатывать через ~5–10 минут после публикации — это нормально.

## Секреты

Задаются в Cloudflare, в репозитории их нет (см. `.dev.vars.example`):

```bash
npx wrangler secret put TELEGRAM_TOKEN      # токен бота (вводит владелец)
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put RUN_KEY
npx wrangler secret put WEBHOOK_SECRET
```

Локальные копии `RUN_KEY` и `WEBHOOK_SECRET` лежат в `.run_key` и `.webhook_secret` (в `.gitignore`).
После смены `WEBHOOK_SECRET` или токена — вызвать `/setup`.

## Эксплуатация и неполадки

| Симптом | Причина / что делать |
|---|---|
| ⚠️ «Kleinanzeigen: сбой проверки» | чаще всего разовые 403; если часто — смотреть `npm run tail`; если сменилась разметка — поправить `fetchKleinanzeigen` |
| ⚠️ «уже 3 ч ни одного объявления» | сайт изменился или блокирует; проверить `npm run check` |
| ⛔ Neue Rostocker в отчёте | известная блокировка облачных IP; обходить нельзя (см. решения) |
| нет отчёта в 21:00 | бот не запускается: Cloudflare dashboard → Workers → `rostock-wohnung-bot` → Logs |
| кнопки не реагируют | webhook сброшен → `/setup?key=…` |
| `cpuTime` > 10 мс | бесплатный тариф пока не обрывает такие запуски, но может; разгрузить разбор или тариф Workers Paid (5 $/мес) |

## Ограничения и принятые решения

**Лимиты бесплатного Cloudflare (на аккаунт):** 10 мс CPU на запуск; **5 cron-расписаний** — заняты все
(3 у этого бота, 2 у `iphone-alert-bot`); KV — 1000 записей в сутки (этот бот ~600–700/сутки). Новое
расписание добавить нельзя — объединяйте задачи в существующие запуски.

**Решения владельца и этические рамки (не менять без него):**
- **Не обходить защиту от ботов:** Immowelt (DataDome), Neue Rostocker (403 для облака), OLX — не подключать через прокси, headless-браузеры, решатели капч.
- **Не отправлять сообщения арендодателям автоматически** — только готовить текст; отправляет человек (правила порталов, риск блокировки аккаунта, качество откликов).
- Письмо — короткое и нейтральное; **не упоминать** статус беженца, Jobcenter, родственников (решение владельца).
- Отбор — только по цене (лимит Jobcenter) и «не квартира»-стоп-словам; районы/комнаты/площадь лишь сортируют (⭐).

**История:** сначала использовался open-source **Fredy** на Mac (см. `legacy/fredy-local/`), затем Oracle Cloud
(отказ в регистрации), затем свой Worker — этот репозиторий.
