// Health of THIS server for the balancer in front: is the application up, and is the local database the one that
// may take writes. A sidecar agent answers GET /_edge/health with 200 only when the server can really serve users.
//
// "node": {
//   "appHealthUrl": "http://host.docker.internal:3001/health",   // the application next to this agent
//   "database": "odora_1",                                       // id of the local node in database.nodes
//   "peers": ["https://origin-2.odora.uz/_edge/health"]          // the other servers' agents
// }
//
// Fencing: after a failover the other server's database runs on a higher timeline ("generation"). A server that
// comes back as the old primary must not get traffic again, so an agent that has ever seen a peer primary with a
// higher generation stays not-ready until its own database reaches it (i.e. it was rebuilt as a replica and, later,
// promoted). What was seen is kept on disk, so it survives restarts and a peer that is unreachable later.
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { nodeStatus } from './db.js';

const timed = async (url, timeoutMs) => {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  const text = (await response.text()).slice(0, 4096);
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body };
};

export class NodeHealth {
  /** `load` returns the current configuration; `stateFile` keeps the highest peer generation ever seen. */
  constructor(load, stateFile, { ttlMs = 2000, now = () => Date.now(), probe = timed, database = nodeStatus } = {}) {
    Object.assign(this, { load, stateFile, ttlMs, now, probe, database });
    this.cached = null; this.pending = null; this.fence = null;
  }

  async #readFence() {
    if (this.fence) return this.fence;
    try { this.fence = JSON.parse(await readFile(this.stateFile, 'utf8')); } catch { this.fence = { generation: 0 }; }
    return this.fence;
  }
  async #raiseFence(generation, peer) {
    this.fence = { generation, peer, seenAt: new Date(this.now()).toISOString() };
    try {
      await writeFile(this.stateFile + '.tmp', JSON.stringify(this.fence));
      await rename(this.stateFile + '.tmp', this.stateFile);
    } catch (error) { console.error(JSON.stringify({ type: 'error', message: 'Cannot persist fence state: ' + error.message })); }
  }

  /** Cached for a couple of seconds: the balancer and the peers poll this often. */
  get() {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return Promise.resolve(this.cached.value);
    return this.pending ??= this.#compute().then(value => { this.cached = { at: this.now(), value }; return value; }).finally(() => { this.pending = null; });
  }

  async #compute() {
    const config = this.load();
    const node = config.node || {};
    const timeoutMs = Math.min(config.timeoutMs, 3000);

    const app = node.appHealthUrl
      ? await this.probe(node.appHealthUrl, timeoutMs).then(result => ({ ok: result.status >= 200 && result.status < 400, status: result.status, version: result.body?.version ?? null }), () => ({ ok: false, status: null, version: null }))
      : { ok: true, status: null, version: null, unchecked: true };

    let db = null;
    const local = node.database && config.database?.nodes.find(item => item.id === node.database);
    if (local) {
      const status = await this.database(config.database, local);
      db = status.reachable ? { reachable: true, role: status.role, timeline: status.timeline, readOnly: !!status.readOnly } : { reachable: false, role: null, timeline: null, error: status.error };
    }

    // Peers that serve as primary on a higher generation fence this node, now and after they disappear.
    const fence = await this.#readFence();
    const peers = await Promise.all((node.peers || []).map(url => this.probe(url, timeoutMs).then(result => ({ url, role: result.body?.db?.role ?? null, timeline: result.body?.db?.timeline ?? null }), () => ({ url, role: null, timeline: null }))));
    for (const peer of peers) if (peer.role === 'primary' && Number.isInteger(peer.timeline) && peer.timeline > fence.generation) await this.#raiseFence(peer.timeline, peer.url);
    const fenced = !!db && db.role === 'primary' && db.timeline < this.fence.generation;

    const writable = !db || (db.reachable && db.role === 'primary' && !db.readOnly);
    const reason = !app.ok ? 'app_unavailable' : !db ? null : !db.reachable ? 'database_unreachable' : db.role !== 'primary' ? 'database_is_replica' : fenced ? 'fenced_old_primary' : db.readOnly ? 'database_read_only' : null;
    return { ready: app.ok && writable && !fenced, reason, app, db, fenced, fenceGeneration: this.fence.generation || null, peers };
  }
}

export const fenceFile = configPath => path.join(path.dirname(path.resolve(configPath)), 'fence.json');
