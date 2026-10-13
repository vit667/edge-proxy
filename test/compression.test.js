import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { once } from 'node:events';
import { proxy } from '../src/proxy.js';

for (const [encoding, compress] of [['gzip', gzipSync], ['br', brotliCompressSync], ['deflate', deflateSync]]) {
  test(`Node proxy returns decoded ${encoding} CSS without compression headers`, async () => {
    const css = 'body { background: #123456; }';
    const body = compress(Buffer.from(css));
    const origin = http.createServer((req, res) => {
      assert.equal(req.headers['accept-encoding'], 'gzip, deflate, br');
      res.writeHead(200, { 'content-type': 'text/css', 'content-encoding': encoding, 'content-length': body.length }); res.end(body);
    });
    origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
    try {
      const config = { timeoutMs: 2000, maxBodyBytes: 100, origins: [{ id: 'main', url: `http://127.0.0.1:${origin.address().port}`, priority: 1 }] };
      const response = await proxy(new Request('http://edge.example/style.css', { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } }), config, fetch, { decodedResponse: true });
      assert.equal(response.headers.has('content-encoding'), false);
      assert.equal(response.headers.has('content-length'), false);
      assert.equal(response.headers.get('content-type'), 'text/css');
      assert.equal(await response.text(), css);
    } finally { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
  });
}
test('Worker path preserves compression metadata unless decoding is requested', async () => {
  const response = await proxy(new Request('https://edge.example'), { timeoutMs: 500, maxBodyBytes: 100, origins: [{ id: 'origin', url: 'https://origin.example', priority: 1 }] }, async () => new Response('body', { headers: { 'content-encoding': 'gzip' } }));
  assert.equal(response.headers.get('content-encoding'), 'gzip');
});
test('unsupported encoding retains its metadata and bytes in the Node path', async () => {
  const bytes = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
  const response = await proxy(new Request('http://edge.example'), { timeoutMs: 500, maxBodyBytes: 100, origins: [{ id: 'origin', url: 'https://origin.example', priority: 1 }] }, async (_, options) => {
    assert.equal(options.headers.get('accept-encoding'), 'gzip, deflate, br');
    return new Response(bytes, { headers: { 'content-encoding': 'zstd' } });
  }, { decodedResponse: true });
  assert.equal(response.headers.get('content-encoding'), 'zstd');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});
