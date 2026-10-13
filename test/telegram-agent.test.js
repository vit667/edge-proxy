import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const readBody = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString(); };

test('agent: Telegram webhook route, counters and Bot API helpers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edge-telegram-test-'));
  let child;
  const updates = [];
  let lastHeaders = {};
  const app = http.createServer(async (req, res) => {
    updates.push({ path: req.url, secret: req.headers['x-telegram-bot-api-secret-token'], body: await readBody(req) });
    lastHeaders = req.headers;
    res.end('ok');
  });
  // Stand-in for api.telegram.org: remembers setWebhook and reports it in getWebhookInfo.
  let webhook = { url: '', pending_update_count: 3, last_error_date: 1791800000, last_error_message: 'Connection refused' };
  const telegram = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req) || '{}');
    res.setHeader('content-type', 'application/json');
    if (!req.url.startsWith('/botbot-token-123/')) { res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); return; }
    if (req.url.endsWith('/setWebhook')) { assert.equal(body.secret_token, 'tg_secret-value'); webhook = { url: body.url, pending_update_count: 0 }; res.end(JSON.stringify({ ok: true, result: true })); return; }
    res.end(JSON.stringify({ ok: true, result: webhook }));
  });
  try {
    const [appPort, telegramPort, agentPort, uiPort] = [await listen(app), await listen(telegram), await freePort(), await freePort()];
    const config = {
      app: 'telegram', revision: 1, timeoutMs: 1000, maxBodyBytes: 4096, healthIntervalMs: 60000,
      origins: [{ id: 'app', priority: 1, url: `http://127.0.0.1:${appPort}`, healthPath: '/' }],
      webhooks: [
        { id: 'bot', path: '/telegram/webhook', provider: 'telegram', secretEnv: 'TG_SECRET', botTokenEnv: 'TG_BOT_TOKEN' },
        { id: 'unset', path: '/telegram/other', provider: 'telegram', secretEnv: 'TG_MISSING' }
      ]
    };
    const configPath = path.join(dir, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    const adminToken = 'telegram-test-admin-token-123456';
    child = spawn(process.execPath, ['src/server.js'], { env: {
      ...process.env, CONFIG_PATH: configPath, PORT: String(agentPort), UI_PORT: String(uiPort), HOST: '127.0.0.1', UI_HOST: '127.0.0.1',
      EDGE_TOKEN: 'telegram-test-edge-token-1234567', ADMIN_TOKEN: adminToken, EDGE_AUTH_DISABLED: '0', ACCESS_LOG: '0', NODE_ID: 'node-a', TRUST_PROXY: '1',
      TG_SECRET: 'tg_secret-value', TG_BOT_TOKEN: 'bot-token-123', TG_MISSING: '', TELEGRAM_API_BASE: `http://127.0.0.1:${telegramPort}`
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000); timer.unref();
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('Control panel')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => reject(new Error('Agent exited before startup')));
    });
    const base = `http://127.0.0.1:${agentPort}`, ui = `http://127.0.0.1:${uiPort}`;
    const admin = { 'x-admin-token': adminToken, 'content-type': 'application/json' };
    const deliver = (secret, options = {}) => fetch(base + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body: '{"update_id":7}', ...options });

    assert.equal((await deliver('tg_secret-value', { headers: { 'x-telegram-bot-api-secret-token': 'tg_secret-value', 'x-forwarded-for': '6.6.6.6, 149.154.167.220' } })).status, 200, 'no x-edge-token needed');
    assert.equal(lastHeaders['x-forwarded-for'], '149.154.167.220', 'the address appended by the trusted proxy, not the client-supplied one');
    assert.equal(lastHeaders['x-edge-via'], 'node-a');
    const loop = await deliver('tg_secret-value', { headers: { 'x-telegram-bot-api-secret-token': 'tg_secret-value', 'x-edge-via': 'node-b,node-a' } });
    assert.equal(loop.status, 508, 'a request that already passed this node is not forwarded again');
    assert.equal((await deliver('wrong')).status, 401);
    assert.equal((await deliver(null)).status, 401);
    assert.equal((await fetch(base + '/telegram/webhook')).status, 405);
    assert.equal((await fetch(base + '/telegram/other', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': '' }, body: '{}' })).status, 503, 'route without a secret fails closed');
    assert.deepEqual(updates.filter(update => update.path !== '/'), [{ path: '/telegram/webhook', secret: 'tg_secret-value', body: '{"update_id":7}' }]);

    const status = await (await fetch(ui + '/admin/status', { headers: admin })).json();
    const bot = status.webhooks.find(item => item.id === 'bot');
    assert.equal(bot.accepted, 1); assert.equal(bot.rejected, 3); assert.equal(bot.secretConfigured, true); assert.equal(bot.botTokenConfigured, true);
    assert.equal(status.webhooks.find(item => item.id === 'unset').secretConfigured, false);
    const log = (await (await fetch(ui + '/admin/traffic', { headers: admin })).json()).log;
    assert.equal(log.find(entry => entry.status === 401).error, 'BAD_SECRET');

    const info = await (await fetch(ui + '/admin/webhooks/telegram?id=bot', { headers: admin })).json();
    assert.equal(info.pendingUpdates, 3); assert.equal(info.lastError, 'Connection refused'); assert.equal(info.pathMatches, null);
    assert.equal((await fetch(ui + '/admin/webhooks/telegram', { method: 'POST', headers: admin, body: JSON.stringify({ id: 'bot', publicUrl: 'http://edge.example' }) })).status, 400, 'https only');
    const set = await (await fetch(ui + '/admin/webhooks/telegram', { method: 'POST', headers: admin, body: JSON.stringify({ id: 'bot', publicUrl: 'https://edge.example' }) })).json();
    assert.equal(set.url, 'https://edge.example/telegram/webhook'); assert.equal(set.pathMatches, true);
    assert.ok(!JSON.stringify(set).includes('bot-token-123') && !JSON.stringify(set).includes('tg_secret-value'), 'secrets never leave the agent');
    assert.equal((await fetch(ui + '/admin/webhooks/telegram?id=unset', { headers: admin })).status, 409, 'no bot token configured');
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill(); await exited; }
    app.closeAllConnections(); telegram.closeAllConnections();
    await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => telegram.close(resolve))]);
    await rm(dir, { recursive: true, force: true });
  }
});
