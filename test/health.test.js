import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOrigin } from '../src/health.js';
import { validateConfig } from '../src/proxy.js';
test('configured root is healthy while missing healthz is a 404', async () => {
  const origin = { id: 'site', url: 'https://site.example', priority: 1 };
  const fetcher = async url => new Response(null, { status: url.pathname === '/' ? 200 : 404 });
  assert.equal((await checkOrigin(origin, 100, fetcher)).healthy, false);
  assert.equal((await checkOrigin({ ...origin, healthPath: '/' }, 100, fetcher)).healthy, true);
});
test('DNS errors and timeouts are distinguished', async () => {
  const origin = { id: 'site', url: 'https://site.example' };
  assert.equal((await checkOrigin(origin, 100, async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); })).error, 'DNS');
  assert.equal((await checkOrigin(origin, 100, async () => { throw new DOMException('timeout', 'TimeoutError'); })).error, 'TIMEOUT');
});
test('health path cannot escape configured origin', () => {
  const config = { app: 'site', revision: 1, timeoutMs: 100, maxBodyBytes: 100, origins: [{ id: 'site', url: 'https://site.example', priority: 1, healthPath: '//evil.example' }] };
  assert.throws(() => validateConfig(config));
});
