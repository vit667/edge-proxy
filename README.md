# Edge Webhook Proxy

HTTP/webhook-балансер перед odora: Cloudflare Worker и/или локальный агент (Node.js) принимают запросы и распределяют их по источникам (origins) с проверкой здоровья и автоматическим исключением упавших. Агент также показывает и управляет физической репликацией PostgreSQL. Панель управления собрана на компонентах и токенах odora.

```text
Клиент → Cloudflare Worker / агент → источник A / B / C   (приоритет, вес, circuit breaker)
                                   ↘ панель управления (отдельный порт) → PostgreSQL main → standby / replica
```

Развёртывание на сервере odora (systemd, nginx, Telegram): [DEPLOY.md](DEPLOY.md).

## Быстрый старт (Node.js 22+)

```powershell
npm install
npm run build:ui                     # собирает панель в ui/dist
npm run demo                         # в отдельном окне: демо-источники на 9101–9103
Copy-Item config.example.json config.local.json
$env:ADMIN_TOKEN = 'local-admin-token-change-me-123456'
$env:EDGE_TOKEN  = 'local-edge-token-change-me-1234567'
npm start
```

- Прокси: http://127.0.0.1:8787 (заголовок `x-edge-token` или вход через браузер).
- Панель: http://127.0.0.1:8788 (ADMIN_TOKEN). Для разработки интерфейса: `npm run dev:ui` (Vite на 5178 проксирует `/admin` на 8788).

Переменные можно держать в `.env` и запускать `node --env-file=.env src/server.js`.

## Балансировка и отказоустойчивость

- **Порядок.** Запрос идёт в доступный источник с наименьшим `priority`; при равном приоритете нагрузка делится по `weight` (smooth weighted round-robin, как в nginx).
- **Circuit breaker.** После `circuit.failureThreshold` ошибок подряд (сетевая ошибка, таймаут, 502/503/504) источник исключается на `circuit.cooldownMs`, затем получает один пробный запрос. Упавший main больше не тормозит каждый запрос на время таймаута.
- **Фоновые проверки.** Каждые `healthIntervalMs` агент запрашивает `healthPath` (по умолчанию `/healthz`); провал сразу исключает источник.
- **Таймаут** `timeoutMs` ограничивает только ожидание заголовков ответа. Длинные загрузки, SSE и большие файлы не обрываются.
- **Повторы.** GET/HEAD/OPTIONS повторяются на следующем источнике. POST/PUT/PATCH/DELETE отправляются один раз; после сетевого сбоя ответ `502 delivery_unknown` означает, что сервер мог обработать запрос. `retryWrites: true` разрешает повтор записи только с `Idempotency-Key` и только при дедупликации в приложении.
- **Тело.** Повторяемые запросы буферизуются до `maxBodyBytes`. Записи передаются потоком до `maxUploadBytes` (по умолчанию 50 МБ), поэтому загрузка файлов в odora работает.
- **Заголовки.** Прокси сам выставляет `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`, `X-Forwarded-Proto`; присланные клиентом значения отбрасываются. За доверенным reverse proxy задайте `TRUST_PROXY=1`: тогда IP клиента берётся из `CF-Connecting-IP` или из последнего элемента `X-Forwarded-For` (его дописывает сам nginx, а предыдущие элементы может подставить клиент), а протокол — из `X-Forwarded-Proto`.
- **`rewriteHost: true`** у источника переписывает `Location` и убирает `Domain=` у `Set-Cookie`, чтобы редиректы и cookie оставались на адресе прокси (аналог nginx `proxy_redirect`/`proxy_cookie_domain`).
- **Отладка.** `exposeDebugHeaders: true` добавляет в ответы `X-Edge-Origin` и `X-Edge-Attempts`; по умолчанию топология наружу не раскрывается.
- **Отмена.** Если клиент отключился, запрос к источнику отменяется.
- Нет очереди доставки: если все источники недоступны, клиент получает 503. WebSocket не поддерживается.

## Порты и пути

| Порт | Что обслуживает |
|---|---|
| `PORT` (8787) | Проксирование всего, кроме `/_edge/*`. `/admin` и `/healthz` проходят в приложение. |
| `UI_PORT` (8788) | Панель и admin API (`/admin/*`). Никогда не проксирует. |

Если агенты стоят друг перед другом (два сервера страхуют друг друга), каждый добавляет свой `NODE_ID` (по умолчанию — имя хоста) в `X-Edge-Via`. Запрос, уже прошедший этот узел, получает `508` вместо повторной пересылки.

Служебные пути прокси: `/_edge/healthz` (публичный, для балансировщиков и Docker), `/_edge/login`, `/_edge/logout`.

**Вход через браузер.** `/_edge/login` выдаёт HttpOnly/SameSite=Strict cookie на 8 часов. Она подписана ключом, выведенным из `EDGE_TOKEN`. Выход отзывает cookie на сервере, но список отзыва хранится в памяти и сбрасывается при перезапуске. На вход стоит лимит: 10 попыток за 5 минут с одного IP. Cookie прокси не передаётся приложению. При HTTPS задайте `PROXY_HTTPS=1`.

`EDGE_AUTH_DISABLED=1` отключает проверку токена на порту прокси, при старте об этом пишется предупреждение, а панель показывает баннер. Admin API это не затрагивает.

## Telegram webhooks

Telegram не умеет отправлять `x-edge-token`. Вместо него при `setWebhook` задаётся `secret_token`, и Telegram присылает его в каждом запросе в заголовке `X-Telegram-Bot-Api-Secret-Token`. Для таких путей прокси проверяет этот заголовок, а не токен прокси:

```json
"webhooks": [
  { "id": "odora-bot", "path": "/telegram/webhook", "provider": "telegram",
    "secretEnv": "TELEGRAM_WEBHOOK_SECRET", "botTokenEnv": "TELEGRAM_BOT_TOKEN", "checkSourceIp": false }
]
```

- **Секреты не хранятся в конфигурации.** Маршрут ссылается на имена переменных окружения агента. Конфигурация видна в панели и попадает в историю, сами значения туда не попадают. Секрет: 1–256 символов `A-Z a-z 0-9 _ -`; панель умеет сгенерировать его в браузере.
- **Проверки.** Путь совпадает точно. Принимается только POST, секрет сравнивается за постоянное время. Если переменная не задана, маршрут отвечает 503 на всё: проверка не отключается молча. Заголовок с секретом передаётся приложению, поэтому odora может проверить его ещё раз.
- **`checkSourceIp: true`** дополнительно пропускает только сети Telegram (149.154.160.0/20, 91.108.4.0/22). За Cloudflare или nginx включайте только вместе с `TRUST_PROXY=1`.
- **Повторы.** Обновление отправляется в приложение один раз. При ошибке Telegram сам повторит доставку, а circuit breaker к тому времени уведёт её на живой источник. Поэтому приложение должно отбрасывать повторы по `update_id`.
- **Telegram API из панели.** Если задан `botTokenEnv`, на странице «Webhooks» можно вызвать `getWebhookInfo` (URL, очередь, последняя ошибка, совпадает ли путь) и зарегистрировать webhook (`setWebhook` с вашим публичным HTTPS-адресом и `secret_token`). Запросы к Telegram делает агент; токен бота и секрет в браузер не попадают.
- **Worker.** Поддерживает те же маршруты. Секрет задаётся через `wrangler secret put TELEGRAM_WEBHOOK_SECRET`.

Admin API: `GET /admin/webhooks/telegram?id=…` → `getWebhookInfo`; `POST /admin/webhooks/telegram` `{ "id", "publicUrl", "dropPendingUpdates" }` → `setWebhook`. Счётчики принятых и отклонённых доставок приходят в `GET /admin/status` (`webhooks`), а причины отказа видны в журнале.

## Admin API (UI-порт, заголовок `x-admin-token`, тело — `application/json`)

| Метод и путь | Назначение |
|---|---|
| `GET /admin/status` | конфигурация, состояние источников (circuit, задержка, ошибки, последняя проверка), трафик за 5 минут |
| `GET /admin/traffic` | ряды по минутам за час и последние 200 запросов (без query string) |
| `POST /admin/health/check` | проверить все источники сейчас |
| `POST /admin/config/validate` | проверить конфигурацию без применения |
| `PUT /admin/config` | применить конфигурацию с большей `revision` (атомарная запись файла, без перезапуска) |
| `GET /admin/config/history` | ревизии с момента запуска |
| `GET /admin/db/status` | состояние всех узлов PostgreSQL и предупреждения |
| `POST /admin/db/sync` | `{ "mode": "sync", "standbys": ["standby"], "method": "FIRST", "count": 1 }` или `{ "mode": "async" }` |
| `POST /admin/db/slots`, `DELETE /admin/db/slots` | `{ "node": "main", "slot": "replica" }`; удаляется только неактивный слот |
| `POST /admin/db/promote` | `{ "node": "standby", "fenced": false }` |
| `POST /admin/db/follow` | `{ "node": "replica", "upstream": "standby" }` |

Конфигурация хранится у каждого агента своя; централизованной раздачи пока нет.

## Управление репликацией PostgreSQL

Агент подключается ко всем узлам из раздела `database` по сети (драйвер `pg`), без Docker-сокета и psql:

```json
"database": {
  "name": "edge",
  "nodes": [
    { "id": "main",    "host": "127.0.0.1", "port": 15432, "replicationHost": "main",    "replicationPort": 5432 },
    { "id": "standby", "host": "127.0.0.1", "port": 15433, "replicationHost": "standby", "replicationPort": 5432 }
  ]
}
```

- `host`/`port` — как до узла добирается агент. `replicationHost`/`replicationPort` — как до него добираются другие узлы PostgreSQL (в Docker-сети это имя сервиса).
- `id` — одновременно имя слота и `application_name` узла.
- Учётные записи: `PGUSER`/`PGPASSWORD` — мониторинг (достаточно роли `pg_monitor`); `PG_ADMIN_USER`/`PG_ADMIN_PASSWORD` — управление (суперпользователь: `ALTER SYSTEM`, `pg_promote`). Без них панель работает в режиме «только мониторинг».

Что умеет агент:
- **Статус.** Роль, timeline, LSN, отставание в байтах и секундах, слоты, удерживаемый WAL, upstream каждого standby. Предупреждения: два primary (split brain), нет primary, синхронный standby не подключён (коммиты висят), неактивный слот копит WAL.
- **Синхронный или асинхронный режим.** `synchronous_standby_names` через `ALTER SYSTEM` + `pg_reload_conf()`. Синхронный режим не включится, если нужные standby сейчас не подключены.
- **Promote.** Отказывает, пока другой узел ещё принимает запись; можно продолжить, только подтвердив (`fenced: true`), что прежний primary изолирован. После повышения сбрасывает `synchronous_standby_names` и создаёт слоты для остальных узлов.
- **Follow.** Переключает standby на новый upstream без перезапуска (`primary_conninfo` и `primary_slot_name`, PostgreSQL 13+). Пароль из прежней строки подключения сохраняется и наружу не отдаётся.

Не умеет: возвращать прежний primary. Для этого нужен доступ к файлам на его хосте: `pg_rewind` или новый `pg_basebackup`, после чего узел запускается как standby. Автоматического failover тоже нет: решение о promote принимает оператор.

### Стенд из трёх PostgreSQL 17

```powershell
Copy-Item deploy/.env.example deploy/.env   # замените пароли
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

Main ждёт подтверждения WAL от `standby` (синхронно), `replica` работает асинхронно. Standby и replica создаются через `pg_basebackup` с отдельными слотами. `synchronous_standby_names`, скопированный с main, удаляется сразу после base backup, иначе он заблокировал бы коммиты после promote. Значения, заданные позже через API, сохраняются при перезапуске.

Для локального агента: `PGUSER=edge`, `PGPASSWORD` и `PG_ADMIN_*` = `POSTGRES_PASSWORD` стенда, порты узлов — `MAIN_PORT`/`STANDBY_PORT`/`REPLICA_PORT`. Прежний режим `PG_CONTAINER` (psql через `docker exec`) удалён.

## Docker

```bash
cp deploy/server/agent.env.example agent.env   # заполните токены и секреты
docker compose up -d --build
docker compose logs -f
```

- **Порты.** Прокси слушает `127.0.0.1:8787`: так задумано для nginx на той же машине, для внешнего доступа задайте `EDGE_BIND=0.0.0.0`. Панель всегда на `127.0.0.1:8788`, с сервера её открывают через `ssh -L 8788:127.0.0.1:8788 …`. Номера портов меняются переменными `EDGE_PORT` и `PANEL_PORT`.
- **Конфигурация** лежит в томе `edge-data` (`/data/config.json`). При первом запуске она создаётся из `config.example.json`, дальше правится в панели и переживает пересоздание контейнера.
- **Переменные.** В `agent.env` только токены и секреты. `HOST`, порты и `CONFIG_PATH` внутри контейнера задаёт compose, поэтому значения из `agent.env` их не перебьют.
- **Сервисы на той же машине** доступны как `http://host.docker.internal:<порт>`, если они слушают `0.0.0.0`. Для сервиса, который слушает только `127.0.0.1`, переходите на `network_mode: host` (инструкция в комментарии в `docker-compose.yml`).
- **Защита контейнера.** Файловая система только для чтения, все capabilities сброшены, пользователь не root, лимит памяти 512 МБ, логи с ротацией. Health-check идёт через `/_edge/healthz`.

## Cloudflare Worker

`wrangler secret put EDGE_TOKEN` (токен клиента), `wrangler secret put APP_CONFIG` (JSON с публичными HTTPS-источниками), при работе через агентов — `ORIGIN_TOKEN` (равен `EDGE_TOKEN` агентов). Worker использует те же приоритеты, веса и circuit breaker. Состояние живёт внутри isolate, общего состояния между локациями Cloudflare нет (для этого нужен Durable Object). Токен сравнивается за постоянное время, `APP_CONFIG` разбирается один раз на isolate.

## Проверки

`npm test`: балансировка по весам, circuit breaker, таймаут только на заголовки, отмена при отключении клиента, forwarding-заголовки, перезапись хоста, потоковые загрузки, сессии и их отзыв, изоляция admin API, история конфигурации, разбор `primary_conninfo` и `synchronous_standby_names`, Worker. Сценарий репликации на живом PostgreSQL описан в [VALIDATION.md](VALIDATION.md).

## Дальше

- Другие провайдеры webhook-ов (HMAC-подпись Payme/Click) — по мере появления.
- Durable inbox (Cloudflare Queues / D1) с дедупликацией по `Idempotency-Key`.
- Единый источник конфигурации для всех агентов и Worker.
- Возврат прежнего primary (`pg_rewind`) агентом на хосте БД.
