import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

test('Worker fails closed without a client secret or with a wrong token', async () => {
  assert.equal((await worker.fetch(new Request('https://edge.example'), {})).status, 401);
  assert.equal((await worker.fetch(new Request('https://edge.example', { headers: { 'x-edge-token': 'wrong' } }), { EDGE_TOKEN: 'expected' })).status, 401);
});
test('Worker sends a separate origin token to agents', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_, options) => {
    assert.equal(options.headers.get('x-edge-token'), 'agent-secret');
    return new Response('agent');
  };
  try {
    const result = await worker.fetch(new Request('https://edge.example/event', { headers: { 'x-edge-token': 'client-secret' } }), { EDGE_TOKEN: 'client-secret', ORIGIN_TOKEN: 'agent-secret', APP_CONFIG: JSON.stringify({ app: 'worker', revision: 1, timeoutMs: 500, maxBodyBytes: 1024, origins: [{ id: 'agent', url: 'https://agent.example', priority: 1 }] }) });
    assert.equal(await result.text(), 'agent');
  } finally { globalThis.fetch = original; }
});
