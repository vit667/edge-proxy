import test from 'node:test';
import assert from 'node:assert/strict';
import { proxy, validateConfig } from '../src/proxy.js';
const config = { app: 'test', revision: 1, exposeDebugHeaders: true, timeoutMs: 100, maxBodyBytes: 32, origins: [{ id: 'main', url: 'https://main.example', priority: 1 }, { id: 'standby', url: 'https://standby.example', priority: 2 }, { id: 'replica', url: 'https://replica.example', priority: 3, readOnly: true }] };
test('GET fails over after network failure and 503', async () => {
  let calls = 0;
  const result = await proxy(new Request('https://edge.example/event?a=1'), config, async url => { calls++; if (calls === 1) throw new Error('offline'); if (calls === 2) return new Response('', { status: 503 }); assert.equal(url.href, 'https://replica.example/event?a=1'); return new Response('ok'); });
  assert.equal(await result.text(), 'ok'); assert.equal(result.headers.get('x-edge-attempts'), '3');
});
test('POST has ambiguous delivery and is not automatically repeated', async () => {
  let calls = 0;
  const result = await proxy(new Request('https://edge.example/event', { method: 'POST', body: 'data', headers: { 'idempotency-key': 'k' } }), config, async () => { calls++; throw new Error('timeout'); });
  assert.equal(result.status, 502); assert.equal(calls, 1); assert.equal((await result.json()).error, 'delivery_unknown');
});
test('explicit deduplication contract permits replay, skips read replica, strips secrets', async () => {
  let calls = 0;
  const result = await proxy(new Request('https://edge.example/event', { method: 'POST', body: 'data', headers: { 'idempotency-key': 'k', 'x-edge-token': 'secret', 'x-admin-token': 'admin' } }), { ...config, retryWrites: true }, async (url, options) => { calls++; assert.equal(options.headers.has('x-edge-token'), false); assert.equal(options.headers.has('x-admin-token'), false); assert.equal(new TextDecoder().decode(options.body), 'data'); if (calls === 1) throw new Error('offline'); assert.equal(url.hostname, 'standby.example'); return new Response('ok'); });
  assert.equal(result.status, 200); assert.equal(calls, 2);
});
test('oversized buffered webhook is rejected before any delivery', async () => {
  const request = new Request('https://edge.example', { method: 'POST', body: 'x'.repeat(33), headers: { 'idempotency-key': 'k' } });
  const result = await proxy(request, { ...config, retryWrites: true }, () => { throw new Error('must not fetch'); }); assert.equal(result.status, 413);
});
test('single-delivery uploads are streamed and limited by maxUploadBytes', async () => {
  const declared = await proxy(new Request('https://edge.example', { method: 'POST', body: 'x'.repeat(65), headers: { 'content-length': '65' } }), { ...config, maxUploadBytes: 64 }, () => { throw new Error('must not fetch'); });
  assert.equal(declared.status, 413);
  const overflow = await proxy(new Request('https://edge.example', { method: 'POST', body: 'x'.repeat(65) }), { ...config, maxUploadBytes: 64 }, async (_, options) => new Response(await new Response(options.body).text()));
  assert.equal(overflow.status, 413);
  const streamed = await proxy(new Request('https://edge.example', { method: 'POST', body: 'x'.repeat(40) }), { ...config, maxUploadBytes: 64 }, async (_, options) => {
    assert.ok(options.body instanceof ReadableStream); assert.equal(options.duplex, 'half');
    return new Response(await new Response(options.body).text());
  });
  assert.equal((await streamed.text()).length, 40);
});
test('double slash path cannot escape the configured origin', async () => {
  await proxy(new Request('https://edge.example//evil.example/path'), config, async url => { assert.equal(url.hostname, 'main.example'); return new Response('ok'); });
});
test('redirects are returned without following with credentials', async () => {
  const result = await proxy(new Request('https://edge.example'), config, async (_, options) => { assert.equal(options.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }); }); assert.equal(result.status, 302);
});
test('invalid origins and duplicate ids fail validation', () => {
  assert.throws(() => validateConfig({ ...config, origins: [{ id: 'x', priority: 1, url: 'file:///secret' }] }));
  assert.throws(() => validateConfig({ ...config, origins: [config.origins[0], config.origins[0]] }));
});
