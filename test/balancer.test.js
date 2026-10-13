import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { OriginPool } from '../src/balancer.js';
import { proxy } from '../src/proxy.js';

const origins = [{ id: 'a', url: 'https://a.example', priority: 1, weight: 3 }, { id: 'b', url: 'https://b.example', priority: 1, weight: 1 }, { id: 'c', url: 'https://c.example', priority: 2 }];
const config = { app: 't', revision: 1, timeoutMs: 200, maxBodyBytes: 100, circuit: { failureThreshold: 2, cooldownMs: 1000 }, origins };

test('weighted round-robin spreads requests inside a priority by weight', () => {
  const pool = new OriginPool();
  const firsts = Array.from({ length: 8 }, () => pool.order(origins)[0].id);
  assert.equal(firsts.filter(id => id === 'a').length, 6);
  assert.equal(firsts.filter(id => id === 'b').length, 2);
  assert.ok(!firsts.includes('c'));
});

test('circuit opens after consecutive failures, skips the origin and half-opens after the cooldown', () => {
  let now = 0;
  const pool = new OriginPool(() => now);
  const two = [{ id: 'a', url: 'https://a.example', priority: 1 }, { id: 'c', url: 'https://c.example', priority: 2 }];
  pool.failure('a', 'TIMEOUT', config);
  assert.equal(pool.circuit('a'), 'closed');
  pool.failure('a', 'TIMEOUT', config);
  assert.equal(pool.circuit('a'), 'open');
  assert.deepEqual(pool.order(two).map(o => o.id), ['c', 'a']);
  now = 1500;
  assert.equal(pool.circuit('a'), 'half-open');
  pool.begin('a');
  assert.equal(pool.circuit('a'), 'open', 'only one probe at a time');
  pool.success('a', 10, 200);
  assert.equal(pool.circuit('a'), 'closed');
});

test('a failing main is skipped without waiting for its timeout again', async () => {
  const pool = new OriginPool();
  const calls = [];
  const fetcher = async url => { calls.push(url.hostname); if (url.hostname === 'a.example') throw Object.assign(new Error('down'), { cause: { code: 'ECONNREFUSED' } }); return new Response('ok'); };
  const two = { ...config, origins: [{ id: 'a', url: 'https://a.example', priority: 1 }, { id: 'c', url: 'https://c.example', priority: 2 }] };
  for (let i = 0; i < 3; i++) await proxy(new Request('https://edge.example/'), two, fetcher, { pool });
  assert.deepEqual(calls, ['a.example', 'c.example', 'a.example', 'c.example', 'c.example']);
});

test('timeout covers response headers only: a slow body is delivered completely', async () => {
  const origin = http.createServer((req, res) => { res.writeHead(200); res.write('start;'); setTimeout(() => res.end('end'), 400); });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
  try {
    const response = await proxy(new Request('http://edge.example/'), { ...config, timeoutMs: 150, origins: [{ id: 'a', url: `http://127.0.0.1:${origin.address().port}`, priority: 1 }] });
    assert.equal(await response.text(), 'start;end');
  } finally { origin.closeAllConnections(); origin.close(); }
});

test('client disconnect cancels the upstream request without blaming the origin', async () => {
  const pool = new OriginPool();
  const client = new AbortController();
  const fetcher = (_, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  const pending = proxy(new Request('https://edge.example/'), config, fetcher, { pool, signal: client.signal });
  client.abort();
  assert.equal((await pending).status, 499);
  assert.ok(pool.snapshot(config).every(origin => origin.errors === 0));
});

test('forwarding headers come from the proxy, never from the client', async () => {
  const request = new Request('https://proxy.example/x', { headers: { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6', forwarded: 'for=6.6.6.6' } });
  await proxy(request, config, async (_, options) => {
    assert.equal(options.headers.get('x-forwarded-for'), '10.0.0.7');
    assert.equal(options.headers.get('x-real-ip'), '10.0.0.7');
    assert.equal(options.headers.get('x-forwarded-host'), 'proxy.example');
    assert.equal(options.headers.get('x-forwarded-proto'), 'https');
    assert.equal(options.headers.has('forwarded'), false);
    return new Response('ok');
  }, { clientIp: '10.0.0.7' });
});

test('rewriteHost keeps redirects and cookies on the proxy host', async () => {
  const rewriting = { ...config, origins: [{ id: 'a', url: 'https://app.example', priority: 1, rewriteHost: true }] };
  const response = await proxy(new Request('https://proxy.example/login'), rewriting, async () => {
    const headers = new Headers({ location: 'https://app.example/home?x=1' });
    headers.append('set-cookie', 'sid=1; Domain=app.example; Path=/; HttpOnly');
    headers.append('set-cookie', 'theme=dark; Path=/');
    return new Response(null, { status: 302, headers });
  });
  assert.equal(response.headers.get('location'), 'https://proxy.example/home?x=1');
  assert.deepEqual(response.headers.getSetCookie(), ['sid=1; Path=/; HttpOnly', 'theme=dark; Path=/']);
});

test('debug headers are hidden unless enabled', async () => {
  const response = await proxy(new Request('https://proxy.example/'), config, async () => new Response('ok'));
  assert.equal(response.headers.has('x-edge-origin'), false);
});
