# Развёртывание на сервере odora

Инструкция под текущую схему odora.uz: nginx (TLS, ModSecurity, rate limit) → Next.js `:3030` → Express backend `:3001`. Готовые файлы лежат в [`deploy/server/`](deploy/server).

## Что меняется

```text
                        ┌─────────────────────────── сервер odora.uz ───────────────────────────┐
Пользователи ──HTTPS──▶ │ nginx ── всё остальное (как сейчас) ──▶ Next.js :3030 ──▶ backend :3001 │
Telegram ─────HTTPS──▶  │ nginx ── = /api/telegram/webhook ──▶ агент :8787 ──────▶ backend :3001 │
Вы (SSH-туннель) ─────▶ │                                       панель :8788                     │
                        └────────────────────────────────────────────────────────────────────────┘
```

**Этап 1 (эта инструкция).** Агент стоит только на пути webhook-а Telegram. Весь остальной трафик odora идёт как раньше. Через агент целиком сайт пока пускать нельзя:
- звонки работают через Socket.IO по чистому WebSocket (`transports: ["websocket"]`), а агент WebSocket не проксирует;
- второго сервера с теми же данными пока нет, переключаться некуда.

Что даёт этап 1: проверку `secret_token` до приложения, журнал и счётчики доставок, диагностику бота (`getWebhookInfo`) в панели. Когда появится второй сервер, Telegram продолжит работать при падении одного из них (см. этап 2).

## 0. До начала

1. **Обработчик в odora.** В backend нужен маршрут `POST /api/telegram/webhook`. Сейчас его нет: Telegram в odora пока только тип канала уведомлений. Маршрут должен:
   - быть в списках исключений `isPublicPath` (`src/middleware/auth.ts`) и `EXEMPT_PATHS` (`src/middleware/license.ts`), иначе запрос Telegram получит 401;
   - сам сверять `X-Telegram-Bot-Api-Secret-Token` с тем же секретом: backend слушает `:3001`, и агент не должен быть единственной защитой;
   - отбрасывать повторы по `update_id` (Telegram повторяет доставку при любой ошибке);
   - отвечать 200 быстро, а тяжёлую работу делать после ответа.
2. **Node.js 22+ на сервере**: `node -v`. Если версия старше, см. вариант с Docker в конце.
3. **Порты.** `3001`, `8787`, `8788` не должны быть открыты наружу. Docker-порты обходят ufw: `postgres-prod` опубликован как `3003:5432` на всех интерфейсах, его стоит перевести на `127.0.0.1:3003:5432`.

## 1. Собрать и скопировать агент

На своей машине (PowerShell, из папки `Edge-Webhook-Proxy`):

```powershell
npm run build:ui
tar -czf edge-proxy.tgz --exclude=node_modules --exclude=ui/node_modules --exclude=.git --exclude=.env --exclude=config.local.json --exclude=deploy/.env .
scp edge-proxy.tgz root@odora.uz:/tmp/
```

## 2. Установить на сервере

```bash
# Пользователь без shell и каталоги
useradd --system --no-create-home --shell /usr/sbin/nologin edge-proxy
mkdir -p /opt/edge-proxy /etc/edge-proxy /var/lib/edge-proxy
tar -xzf /tmp/edge-proxy.tgz -C /opt/edge-proxy
cd /opt/edge-proxy && npm ci --omit=dev

# Конфигурация: каталог доступен агенту на запись (панель сохраняет новые ревизии атомарно)
cp deploy/server/config.production.example.json /var/lib/edge-proxy/config.json
chown -R edge-proxy:edge-proxy /var/lib/edge-proxy
chmod 750 /var/lib/edge-proxy

# Секреты: читать может только агент
cp deploy/server/agent.env.example /etc/edge-proxy/agent.env
chown root:edge-proxy /etc/edge-proxy/agent.env
chmod 640 /etc/edge-proxy/agent.env
```

Заполните `/etc/edge-proxy/agent.env`:

```bash
openssl rand -hex 32   # для EDGE_TOKEN
openssl rand -hex 32   # для ADMIN_TOKEN
openssl rand -hex 32   # для TELEGRAM_WEBHOOK_SECRET (этот же секрет нужен backend-у odora)
nano /etc/edge-proxy/agent.env
```

`NODE_ID` должен быть уникальным на каждом сервере (например `odora-1`). `TELEGRAM_BOT_TOKEN` можно не задавать, тогда кнопки Telegram в панели будут недоступны.

Запуск:

```bash
cp deploy/server/edge-proxy.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now edge-proxy
systemctl status edge-proxy
journalctl -u edge-proxy -n 50           # агент пишет JSON-строку на каждый запрос
curl -s http://127.0.0.1:8787/_edge/healthz
```

## 3. nginx

Вставьте содержимое [`deploy/server/nginx-edge-proxy.conf`](deploy/server/nginx-edge-proxy.conf) в основной `server { listen 443 … server_name odora.uz; }` в `/etc/nginx/sites-available/odora.uz` (и в копию в репозитории `deploy/nginx/sites-available/odora.uz`). Что делают эти блоки:

- `location = /api/telegram/webhook` → агент `:8787`. Точное совпадение важнее `location /api/`, поэтому остальной `/api/` не затронут.
  - **Rate limit не задан намеренно.** Telegram шлёт до 40 параллельных запросов с нескольких адресов, а зона `api` ограничивает по IP.
  - **ModSecurity в режиме DetectionOnly.** В обновлениях лежат тексты сообщений пользователей, и правила CRS (SQLi/XSS) отклонили бы часть из них с 403. Telegram бесконечно повторяет отклонённое обновление, и вся очередь бота встала бы. Защиту здесь обеспечивает secret token, ModSecurity только пишет в лог.
- `location = /health` отдаёт `{"status":"ok"}` от backend. Нужен для проверок агента на втором сервере (этап 2).

```bash
nginx -t && systemctl reload nginx
```

`proxy_params` уже передаёт `Host`, `X-Forwarded-For` и `X-Forwarded-Proto`. Агент с `TRUST_PROXY=1` берёт IP клиента из последнего элемента `X-Forwarded-For`, то есть из адреса, который дописал сам nginx. Подделать его клиент не может.

## 4. Проверка снаружи

```bash
curl -i -X POST https://odora.uz/api/telegram/webhook -d '{}'
# 401 — агент на месте и требует секрет

curl -i -X POST https://odora.uz/api/telegram/webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" -d '{"update_id":1}'
# ответ backend-а: 200 — обработчик готов; 404/401 — обработчик в odora ещё не добавлен или не в исключениях
```

## 5. Панель и регистрация бота

Панель слушает только `127.0.0.1:8788` на сервере. Откройте SSH-туннель (локальный порт 18788, потому что 8788 у вас занят локальным агентом):

```powershell
ssh -N -L 18788:127.0.0.1:8788 root@odora.uz
```

Затем откройте http://127.0.0.1:18788 и введите `ADMIN_TOKEN` с сервера.

На странице **Webhooks** → **Зарегистрировать** укажите `https://odora.uz`. Агент вызовет `setWebhook` с вашим секретом, и Telegram начнёт слать обновления на `https://odora.uz/api/telegram/webhook`. Кнопка **Проверить** показывает очередь и последнюю ошибку доставки на стороне Telegram.

Без панели то же самое делается одной командой на сервере:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url=https://odora.uz/api/telegram/webhook -d secret_token=<TELEGRAM_WEBHOOK_SECRET>
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Обновление и откат

Обновление: соберите и скопируйте архив, как в шаге 1, затем:

```bash
tar -xzf /tmp/edge-proxy.tgz -C /opt/edge-proxy && cd /opt/edge-proxy && npm ci --omit=dev && systemctl restart edge-proxy
```

Конфигурация в `/var/lib/edge-proxy` и секреты в `/etc/edge-proxy` при обновлении не затираются.

Откат: уберите два `location` из nginx, выполните `nginx -t && systemctl reload nginx` и `systemctl disable --now edge-proxy`. Если бэкенд odora сам проверяет секрет, Telegram продолжит работать через обычный `/api/`, при условии что этот путь не закрыт авторизацией.

## Этап 2: второй сервер

Когда появится второй сервер с той же odora и общими данными (БД — его реплика, которую можно повысить):

1. Установите агент там так же, с другим `NODE_ID` (`odora-2`) и тем же `TELEGRAM_WEBHOOK_SECRET`.
2. В панели каждого сервера на странице **Маршрутизация** добавьте второй источник с приоритетом 2:
   ```json
   { "id": "odora-2", "url": "https://odora-2.example.uz", "priority": 2, "healthPath": "/health" }
   ```
   На втором сервере — зеркально, с адресом первого.
3. Если локальный backend упал, агент перешлёт обновление на другой сервер, и тот обработает его своим backend-ом. Если упали оба, агенты не будут гонять запрос по кругу: каждый ставит свой `NODE_ID` в `X-Edge-Via`, а увидев его повторно, отвечает 508. Telegram повторит доставку позже.
4. **Важно.** Второй backend должен писать в ту же базу или в primary после переключения. Иначе обновления разойдутся по двум разным базам.

PostgreSQL у odora сейчас в Docker (`pgvector/pgvector:pg16`). Для standby нужен `wal_level=replica`, роль репликации, слот и `pg_basebackup` на втором сервере; соединение между серверами только по приватной сети или WireGuard. Управление и мониторинг через панель описаны в [README](README.md#управление-репликацией-postgresql). Для боевой базы это отдельная работа, которую стоит сначала отрепетировать на копии.

## Вариант с Docker

Если на сервере нет Node.js 22 или удобнее держать всё в Docker:

```bash
cd /opt/edge-proxy
cp deploy/server/agent.env.example agent.env && chmod 600 agent.env   # заполните
docker compose up -d --build
```

В nginx ничего не меняется: агент так же слушает `127.0.0.1:8787`. В конфигурации агента backend указывается как `http://host.docker.internal:3001`, потому что `127.0.0.1` внутри контейнера — это сам контейнер. Подробности в разделе Docker в [README](README.md#docker).
