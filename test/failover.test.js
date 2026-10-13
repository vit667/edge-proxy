import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeHealth } from '../src/node-health.js';
import { OriginPool } from '../src/balancer.js';
import { validateConfig } from '../src/proxy.js';
import worker from '../src/worker.js';

const base = { app: 'odora', revision: 1, timeoutMs: 1000, maxBodyBytes: 1024 };
const database = { name: 'erp', nodes: [{ id: 'odora_1', host: '10.0.0.1', port: 5432 }, { id: 'odora_2', host: '10.0.0.2', port: 5432 }] };

test('node section is validated against the database nodes', () => {
  const config = { ...base, origins: [{ id: 'app', url: 'http://127.0.0.1:3001', priority: 1 }], database };
  assert.doesNotThrow(() => validateConfig({ ...config, node: { appHealthUrl: 'http://127.0.0.1:3001/health', database: 'odora_1', peers: ['https://origin-2.example/_edge/health'] } }));
  assert.throws(() => validateConfig({ ...config, node: { database: 'unknown' } }));
  assert.throws(() => validateConfig({ ...config, node: { appHealthUrl: 'ftp://x' } }));
});

test('a server is ready only with a live application and a writable primary database', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edge-node-'));
  try {
    const config = { ...base, database, node: { appHealthUrl: 'http://app/health', database: 'odora_1' } };
    let app = 200, db = { reachable: true, role: 'primary', timeline: 1, readOnly: false };
    const health = () => new NodeHealth(() => config, path.join(dir, 'fence.json'), { ttlMs: 0, probe: async () => ({ status: app, body: { version: '1.0.0' } }), database: async () => db }).get();

    assert.deepEqual((({ ready, reason }) => ({ ready, reason }))(await health()), { ready: true, reason: null });
    app = 503;
    assert.equal((await health()).reason, 'app_unavailable');
    app = 200; db = { reachable: true, role: 'standby', timeline: 1, readOnly: true };
    assert.deepEqual((({ ready, reason }) => ({ ready, reason }))(await health()), { ready: false, reason: 'database_is_replica' });
    db = { reachable: false, error: 'CONNECTION' };
    assert.equal((await health()).reason, 'database_unreachable');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an old primary that saw a newer generation on a peer stays fenced, also after a restart and without the peer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'edge-node-'));
  try {
    const file = path.join(dir, 'fence.json');
    const config = { ...base, database, node: { appHealthUrl: 'http://app/health', database: 'odora_1', peers: ['https://peer/_edge/health'] } };
    const local = { reachable: true, role: 'primary', timeline: 1, readOnly: false };
    let peer = { status: 503, body: { db: { role: 'standby', timeline: 1 } } };
    const probe = async url => { if (url.includes('peer')) { if (!peer) throw new Error('down'); return peer; } return { status: 200, body: {} }; };
    const create = () => new NodeHealth(() => config, file, { ttlMs: 0, probe, database: async () => local });

    assert.equal((await create().get()).ready, true, 'the peer is a replica: this server is the primary');
    peer = { status: 200, body: { db: { role: 'primary', timeline: 2 } } };
    const fenced = await create().get();
    assert.deepEqual([fenced.ready, fenced.reason, fenced.fenceGeneration], [false, 'fenced_old_primary', 2]);
    peer = null;
    assert.equal((await create().get()).reason, 'fenced_old_primary', 'remembered on disk when the peer is unreachable');
    local.timeline = 3;
    assert.equal((await create().get()).ready, true, 'promoted again on a newer generation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the balancer never routes to an origin with an older database generation', () => {
  const origins = [{ id: 's1', url: 'https://s1.example', priority: 1 }, { id: 's2', url: 'https://s2.example', priority: 2 }];
  const config = { ...base, origins };
  const pool = new OriginPool();
  pool.checked({ id: 's1', healthy: true, status: 200, latencyMs: 5, generation: 1 }, config);
  pool.checked({ id: 's2', healthy: false, status: 503, latencyMs: 5, generation: null }, config);
  assert.equal(pool.order(origins)[0].id, 's1');
  pool.checked({ id: 's2', healthy: true, status: 200, latencyMs: 5, generation: 2 }, config);
  assert.deepEqual(pool.order(origins).map(origin => origin.id), ['s2'], 's1 is dropped, not kept as a last resort');
  // The newer server disappears: the stale one still must not serve.
  pool.checked({ id: 's2', healthy: false, error: 'CONNECTION', latencyMs: 5, generation: null }, config);
  assert.ok(!pool.order(origins).some(origin => origin.id === 's1'));
});

test('Worker: public site fails over to the promoted server and does not go back to the old primary', async () => {
  const servers = {
    'origin-1.example': { up: true, health: { status: 200, body: { ready: true, db: { role: 'primary', timeline: 1 } } } },
    'origin-2.example': { up: true, health: { status: 503, body: { ready: false, reason: 'database_is_replica', db: { role: 'standby', timeline: 1 } } } }
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const server = servers[url.hostname];
    if (!server.up) throw Object.assign(new Error('down'), { cause: { code: 'ECONNREFUSED' } });
    if (url.pathname === '/_edge/health') return Response.json(server.health.body, { status: server.health.status });
    if (options?.headers?.get?.('upgrade') === 'websocket') return new Response('ws:' + url.hostname + ':' + options.headers.get('sec-websocket-key') + ':' + options.headers.get('x-forwarded-host'));
    return new Response(url.hostname);
  };
  // Each step changes the configuration text, which makes the Worker check the origins again.
  let revision = 100;
  const env = () => ({ APP_CONFIG: JSON.stringify({ ...base, revision: ++revision, publicAccess: true, circuit: { failureThreshold: 1, cooldownMs: 1000 }, origins: [
    { id: 'odora_1', url: 'https://origin-1.example', priority: 1, healthPath: '/_edge/health' },
    { id: 'odora_2', url: 'https://origin-2.example', priority: 2, healthPath: '/_edge/health' }] }) });
  const visit = async (init = {}) => (await worker.fetch(new Request('https://odora.example/dashboard', init), env(), { waitUntil() {} }));
  try {
    assert.equal(await (await visit()).text(), 'origin-1.example', 'no x-edge-token needed in public mode');
    assert.equal(await (await visit({ headers: { upgrade: 'websocket', 'sec-websocket-key': 'k1' } })).text(), 'ws:origin-1.example:k1:odora.example', 'WebSocket goes to the same server with its headers intact');

    servers['origin-1.example'].up = false;
    assert.equal((await visit()).status, 503, 'server 1 is gone and server 2 is still a replica: nothing may serve');

    servers['origin-2.example'].health = { status: 200, body: { ready: true, db: { role: 'primary', timeline: 2 } } };
    assert.equal(await (await visit()).text(), 'origin-2.example', 'after the promotion traffic moves by itself');

    servers['origin-1.example'].up = true; // back from the dead, still believing it is the primary of generation 1
    assert.equal(await (await visit()).text(), 'origin-2.example', 'the higher priority of server 1 does not bring traffic back');
    assert.equal(await (await visit({ headers: { upgrade: 'websocket', 'sec-websocket-key': 'k2' } })).text(), 'ws:origin-2.example:k2:odora.example');
  } finally { globalThis.fetch = original; }
});
