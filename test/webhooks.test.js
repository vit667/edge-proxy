import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWebhooks, verifyWebhook, inNetworks, findWebhook } from '../src/webhooks.js';
import { equal } from '../src/browser-auth.js';
import worker from '../src/worker.js';

const route = { id: 'telegram', path: '/telegram/webhook', provider: 'telegram', secretEnv: 'TELEGRAM_WEBHOOK_SECRET' };
const post = (headers = {}) => new Request('https://edge.example/telegram/webhook', { method: 'POST', headers, body: '{"update_id":1}' });

test('webhook routes validate ids, paths, providers and env names', () => {
  assert.doesNotThrow(() => validateWebhooks([route]));
  assert.throws(() => validateWebhooks([{ ...route, provider: 'stripe' }]));
  assert.throws(() => validateWebhooks([{ ...route, secretEnv: 'lower' }]));
  assert.throws(() => validateWebhooks([{ ...route, path: '/_edge/login' }]));
  assert.throws(() => validateWebhooks([{ ...route, path: 'relative' }]));
  assert.throws(() => validateWebhooks([route, { ...route, id: 'other' }]), /path/);
  assert.equal(findWebhook({ webhooks: [route] }, '/telegram/webhook/'), null, 'paths match exactly');
});

test('Telegram deliveries need the secret token header and POST', () => {
  const options = { secret: 's3cret', clientIp: '1.2.3.4', equal };
  assert.equal(verifyWebhook(route, post({ 'x-telegram-bot-api-secret-token': 's3cret' }), options), null);
  assert.deepEqual(verifyWebhook(route, post({ 'x-telegram-bot-api-secret-token': 'wrong' }), options), { status: 401, reason: 'BAD_SECRET' });
  assert.deepEqual(verifyWebhook(route, post(), options), { status: 401, reason: 'BAD_SECRET' });
  assert.deepEqual(verifyWebhook(route, new Request('https://edge.example/telegram/webhook'), options), { status: 405, reason: 'METHOD' });
  assert.deepEqual(verifyWebhook(route, post({ 'x-telegram-bot-api-secret-token': 's3cret' }), { ...options, secret: undefined }), { status: 503, reason: 'SECRET_NOT_SET' }, 'fails closed without a secret');
});

test('optional source check accepts only Telegram networks', () => {
  assert.equal(inNetworks('149.154.167.220', ['149.154.160.0/20']), true);
  assert.equal(inNetworks('::ffff:91.108.6.10', ['91.108.4.0/22']), true);
  assert.equal(inNetworks('149.154.176.1', ['149.154.160.0/20']), false);
  assert.equal(inNetworks('2001:db8::1', ['149.154.160.0/20']), false);
  const checked = { ...route, checkSourceIp: true };
  const headers = { 'x-telegram-bot-api-secret-token': 's3cret' };
  assert.deepEqual(verifyWebhook(checked, post(headers), { secret: 's3cret', clientIp: '8.8.8.8', equal }), { status: 403, reason: 'SOURCE_IP' });
  assert.equal(verifyWebhook(checked, post(headers), { secret: 's3cret', clientIp: '149.154.167.220', equal }), null);
});

test('Worker accepts Telegram without x-edge-token and rejects a wrong secret', async () => {
  const env = {
    EDGE_TOKEN: 'client-secret', TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
    APP_CONFIG: JSON.stringify({ app: 'w', revision: 1, timeoutMs: 500, maxBodyBytes: 1024, webhooks: [route], origins: [{ id: 'app', url: 'https://app.example', priority: 1 }] })
  };
  const original = globalThis.fetch;
  let delivered = 0;
  globalThis.fetch = async (url, options) => { delivered++; assert.equal(url.pathname, '/telegram/webhook'); assert.equal(await new Response(options.body).text(), '{"update_id":1}'); return new Response('ok'); };
  try {
    assert.equal((await worker.fetch(post({ 'x-telegram-bot-api-secret-token': 'wrong' }), env)).status, 401);
    assert.equal((await worker.fetch(post({ 'x-telegram-bot-api-secret-token': 'tg-secret' }), env)).status, 200);
    assert.equal(delivered, 1);
    assert.equal((await worker.fetch(new Request('https://edge.example/other', { method: 'POST' }), env)).status, 401, 'other paths still need x-edge-token');
  } finally { globalThis.fetch = original; }
});
