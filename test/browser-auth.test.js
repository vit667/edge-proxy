import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, readSession, sessionKey, RevokedSessions, LoginLimiter } from '../src/browser-auth.js';
import { proxy } from '../src/proxy.js';
test('browser session signature rejects tampering, wrong keys and revoked cookies', () => {
  const key = sessionKey('secret-token');
  const cookie = issueSession(key, true);
  assert.match(cookie, /; Secure/);
  const session = readSession(cookie, key);
  assert.ok(session);
  assert.equal(readSession(cookie, sessionKey('another-token')), null);
  assert.equal(readSession(cookie.replace('edge_proxy_session=', 'edge_proxy_session=0'), key), null);
  assert.equal(readSession('edge_proxy_session=1.' + 'a'.repeat(32) + '.invalid', key), null);
  const revoked = new RevokedSessions(); revoked.add(session);
  assert.equal(readSession(cookie, key, revoked), null);
});
test('login limiter blocks after the limit within a window', () => {
  const limiter = new LoginLimiter(2, 60000);
  assert.equal(limiter.allow('ip'), true); assert.equal(limiter.allow('ip'), true); assert.equal(limiter.allow('ip'), false);
  assert.equal(limiter.allow('other'), true);
});
test('origin receives application cookies without proxy session', async () => {
  const config = { timeoutMs: 500, maxBodyBytes: 100, origins: [{ id: 'main', url: 'https://origin.example', priority: 1 }] };
  await proxy(new Request('https://edge.example', { headers: { cookie: 'app_session=abc; edge_proxy_session=private' } }), config, async (_, options) => {
    assert.equal(options.headers.get('cookie'), 'app_session=abc'); return new Response('ok');
  });
});
