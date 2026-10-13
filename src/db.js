// Simplified PostgreSQL replication control: status of every node, synchronous mode, slots, promotion and re-pointing a
// standby to another upstream. Everything is plain SQL over the network, so the agent needs no Docker socket or shell.
// Not covered: re-joining a former primary (pg_rewind / new base backup) — that needs file access on its host.
import pg from 'pg';

const monitor = () => ({ user: process.env.PGUSER || 'edge_monitor', password: process.env.PGPASSWORD });
const admin = () => process.env.PG_ADMIN_USER ? { user: process.env.PG_ADMIN_USER, password: process.env.PG_ADMIN_PASSWORD } : null;
export const controlEnabled = () => !!admin();

export class DbError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}

async function withClient(database, node, role, task) {
  const credentials = role === 'admin' ? admin() : monitor();
  if (!credentials) throw new DbError('control_disabled', 'Set PG_ADMIN_USER and PG_ADMIN_PASSWORD to enable replication control', 403);
  const client = new pg.Client({
    host: node.host, port: node.port, database: database.name || process.env.PGDATABASE || 'postgres', ...credentials,
    connectionTimeoutMillis: 3000, statement_timeout: 10000, application_name: 'edge-agent'
  });
  client.on('error', () => {});
  await client.connect();
  try { return await task(client); } finally { await client.end().catch(() => {}); }
}

const statusSql = `
SELECT
  current_setting('server_version') AS version,
  pg_is_in_recovery() AS "inRecovery",
  current_setting('transaction_read_only') = 'on' AS "readOnly",
  -- A standby's checkpoint timeline lags until its next restartpoint; the WAL receiver knows the current one.
  coalesce(CASE WHEN pg_is_in_recovery() THEN (SELECT received_tli FROM pg_stat_wal_receiver) END,
           (SELECT timeline_id FROM pg_control_checkpoint())) AS timeline,
  CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_current_wal_lsn()::text END AS "currentLsn",
  pg_last_wal_receive_lsn()::text AS "receivedLsn",
  pg_last_wal_replay_lsn()::text AS "replayedLsn",
  pg_last_xact_replay_timestamp() AS "lastReplayAt",
  current_setting('synchronous_standby_names') AS "synchronousStandbyNames",
  current_setting('synchronous_commit') AS "synchronousCommit",
  current_setting('primary_conninfo') AS "primaryConninfo",
  current_setting('primary_slot_name') AS "primarySlotName",
  (SELECT row_to_json(r) FROM (SELECT status, sender_host AS "senderHost", sender_port AS "senderPort", slot_name AS "slotName"
     FROM pg_stat_wal_receiver) r) AS receiver,
  (SELECT coalesce(json_agg(s ORDER BY s.name), '[]') FROM (
     SELECT application_name AS name, client_addr::text AS "clientAddr", state, sync_state AS "syncState",
            replay_lsn::text AS "replayLsn", extract(epoch FROM replay_lag) AS "replayLagSeconds",
            CASE WHEN pg_is_in_recovery() THEN NULL ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint END AS "lagBytes"
     FROM pg_stat_replication) s) AS senders,
  (SELECT coalesce(json_agg(s ORDER BY s.name), '[]') FROM (
     SELECT slot_name AS name, active, wal_status AS "walStatus", safe_wal_size AS "safeWalBytes",
            CASE WHEN pg_is_in_recovery() OR restart_lsn IS NULL THEN NULL
                 ELSE pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint END AS "retainedBytes"
     FROM pg_replication_slots WHERE slot_type = 'physical') s) AS slots`;

// libpq conninfo: key=value pairs, values optionally single-quoted with backslash escapes.
export function parseConninfo(text) {
  const pairs = [];
  const pattern = /\s*([\w]+)\s*=\s*(?:'((?:\\.|[^'\\])*)'|(\S*))/g;
  let match;
  while ((match = pattern.exec(text || ''))) pairs.push([match[1], match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3]]);
  return pairs;
}
export const formatConninfo = pairs => pairs.map(([key, value]) => `${key}='${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' ');

function describe(node, row) {
  const conninfo = Object.fromEntries(parseConninfo(row.primaryConninfo));
  const { primaryConninfo, ...safe } = row; // the conninfo may contain the replication password
  return {
    id: node.id, reachable: true, role: row.inRecovery ? 'standby' : 'primary', ...safe,
    timeline: Number(row.timeline),
    upstream: row.inRecovery ? { host: conninfo.host || null, port: conninfo.port ? Number(conninfo.port) : null, slot: row.primarySlotName || null } : null
  };
}

export async function nodeStatus(database, node) {
  try { return await withClient(database, node, 'monitor', async client => describe(node, (await client.query(statusSql)).rows[0])); }
  catch (error) { return { id: node.id, reachable: false, error: error.code === 'ECONNREFUSED' ? 'CONNECTION' : error.code === '28P01' ? 'AUTH' : error.message.slice(0, 200) }; }
}

const replicationAddress = node => ({ host: node.replicationHost || node.host, port: node.replicationPort || node.port });
const upstreamOf = (database, status) => status.upstream && database.nodes.find(node => {
  const address = replicationAddress(node);
  return address.host === status.upstream.host && (!status.upstream.port || address.port === status.upstream.port);
})?.id || null;

export async function clusterStatus(database) {
  const nodes = await Promise.all(database.nodes.map(node => nodeStatus(database, node)));
  for (const status of nodes) if (status.role === 'standby') status.upstreamId = upstreamOf(database, status);
  const primaries = nodes.filter(node => node.role === 'primary');
  const warnings = [];
  if (primaries.length > 1) warnings.push({ level: 'critical', code: 'split_brain', message: `Несколько узлов принимают запись: ${primaries.map(node => node.id).join(', ')}. Изолируйте прежний primary.` });
  if (!primaries.length && nodes.some(node => node.reachable)) warnings.push({ level: 'critical', code: 'no_primary', message: 'Нет доступного primary: запись невозможна.' });
  for (const primary of primaries) {
    const required = parseSyncNames(primary.synchronousStandbyNames).names;
    const syncConnected = primary.senders.filter(sender => sender.state === 'streaming' && required.includes(sender.name));
    if (required.length && !syncConnected.length) warnings.push({ level: 'critical', code: 'sync_missing', message: `${primary.id}: синхронный standby не подключён — коммиты ждут подтверждения.` });
    for (const slot of primary.slots) if (!slot.active && slot.retainedBytes > 256 * 1024 * 1024) warnings.push({ level: 'warning', code: 'slot_retaining', message: `${primary.id}: неактивный слот ${slot.name} удерживает ${Math.round(slot.retainedBytes / 1048576)} MB WAL.` });
  }
  for (const node of nodes) {
    if (!node.reachable) warnings.push({ level: 'warning', code: 'unreachable', message: `${node.id}: узел недоступен (${node.error}).` });
    else if (node.role === 'standby' && node.receiver?.status !== 'streaming') warnings.push({ level: 'warning', code: 'not_streaming', message: `${node.id}: standby не получает WAL от ${node.upstreamId || node.upstream?.host || 'upstream'}.` });
  }
  return { nodes, primary: primaries.length === 1 ? primaries[0].id : null, warnings, controlEnabled: controlEnabled() };
}

// "FIRST 1 (a, b)", "ANY 2 (a, b, c)", "a, b" (= FIRST 1) or "".
export function parseSyncNames(value) {
  const text = (value || '').trim();
  if (!text) return { method: null, count: 0, names: [] };
  const match = /^(FIRST|ANY)\s+(\d+)\s*\((.*)\)$/i.exec(text) || /^(\d+)\s*\((.*)\)$/.exec(text);
  const list = match ? match[match.length - 1] : text;
  const names = list.split(',').map(name => name.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (!match) return { method: 'FIRST', count: 1, names };
  return { method: match.length === 4 ? match[1].toUpperCase() : 'FIRST', count: Number(match[match.length - 2]), names };
}

function node(database, id) {
  const found = database.nodes.find(item => item.id === id);
  if (!found) throw new DbError('unknown_node', `Unknown database node: ${id}`, 404);
  return found;
}

async function singlePrimary(database) {
  const status = await clusterStatus(database);
  const primaries = status.nodes.filter(item => item.role === 'primary');
  if (primaries.length !== 1) throw new DbError('no_single_primary', 'Exactly one reachable primary is required for this operation');
  return { status, primary: node(database, primaries[0].id), primaryStatus: primaries[0] };
}

const setting = async (client, name, value) => {
  await client.query(value === null ? `ALTER SYSTEM RESET ${name}` : `ALTER SYSTEM SET ${name} = ${client.escapeLiteral(value)}`);
};

/** mode 'async' clears synchronous_standby_names; 'sync' requires the listed standbys to be streaming unless forced. */
export async function setSynchronous(database, { mode, standbys = [], method = 'FIRST', count = 1, force = false }) {
  if (!['sync', 'async'].includes(mode) || !['FIRST', 'ANY'].includes(method) || !Number.isInteger(count) || count < 1) throw new DbError('invalid_request', 'Invalid synchronous mode', 400);
  const { primary, primaryStatus } = await singlePrimary(database);
  let value = '';
  if (mode === 'sync') {
    if (!Array.isArray(standbys) || !standbys.length || count > standbys.length) throw new DbError('invalid_request', 'List the synchronous standbys', 400);
    for (const id of standbys) if (id === primary.id) throw new DbError('invalid_request', 'The primary cannot be its own standby', 400); else node(database, id);
    const streaming = primaryStatus.senders.filter(sender => sender.state === 'streaming').map(sender => sender.name);
    const connected = standbys.filter(id => streaming.includes(id));
    if (connected.length < count && !force) throw new DbError('standby_not_streaming', `Only ${connected.length} of the required ${count} standbys are streaming — commits would block`);
    value = `${method} ${count} (${standbys.join(', ')})`;
  }
  await withClient(database, primary, 'admin', async client => { await setting(client, 'synchronous_standby_names', value); await client.query('SELECT pg_reload_conf()'); });
  return { primary: primary.id, synchronousStandbyNames: value };
}

export async function createSlot(database, { node: id, slot }) {
  const target = node(database, id);
  if (!/^[a-z0-9_]{1,63}$/.test(slot || '')) throw new DbError('invalid_request', 'Invalid slot name', 400);
  return withClient(database, target, 'admin', async client => {
    const { rowCount } = await client.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [slot]);
    if (!rowCount) await client.query('SELECT pg_create_physical_replication_slot($1, true)', [slot]);
    return { node: id, slot, created: !rowCount };
  });
}

export async function dropSlot(database, { node: id, slot }) {
  const target = node(database, id);
  return withClient(database, target, 'admin', async client => {
    const { rows } = await client.query('SELECT active FROM pg_replication_slots WHERE slot_name = $1', [slot]);
    if (!rows.length) throw new DbError('unknown_slot', 'Slot does not exist', 404);
    if (rows[0].active) throw new DbError('slot_active', 'The slot is in use by a connected standby');
    await client.query('SELECT pg_drop_replication_slot($1)', [slot]);
    return { node: id, slot, dropped: true };
  });
}

/**
 * Promotes a standby. Refuses while another reachable node still accepts writes unless the operator confirms
 * that node is fenced (stopped or isolated) — otherwise both would take writes (split brain).
 */
export async function promote(database, { node: id, fenced = false }) {
  const target = node(database, id);
  const status = await clusterStatus(database);
  const current = status.nodes.find(item => item.id === id);
  if (!current.reachable) throw new DbError('unreachable', `${id} is not reachable`);
  if (current.role !== 'standby') throw new DbError('not_standby', `${id} is already a primary`);
  const alive = status.nodes.filter(item => item.role === 'primary').map(item => item.id);
  if (alive.length && !fenced) throw new DbError('primary_alive', `Primary ${alive.join(', ')} is still accepting writes. Fence it first or confirm fencing.`);
  return withClient(database, target, 'admin', async client => {
    const { rows } = await client.query('SELECT pg_promote(true, 60) AS promoted');
    if (!rows[0].promoted) throw new DbError('promote_failed', 'Promotion did not finish in 60 seconds', 500);
    // A copied synchronous_standby_names could name a node that is not attached yet and block every commit.
    await setting(client, 'synchronous_standby_names', null);
    await client.query('SELECT pg_reload_conf()');
    // Slots so the remaining standbys can follow the new primary.
    for (const other of database.nodes) if (other.id !== id) {
      const { rowCount } = await client.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [other.id]);
      if (!rowCount) await client.query('SELECT pg_create_physical_replication_slot($1, true)', [other.id]);
    }
    return { promoted: id, previousPrimaries: alive, note: alive.length ? 'Прежний primary нужно вернуть через pg_rewind или новый base backup.' : undefined };
  });
}

/** Re-points a running standby to another upstream (PostgreSQL 13+: primary_conninfo is reloadable). */
export async function follow(database, { node: id, upstream: upstreamId }) {
  const target = node(database, id);
  const upstream = node(database, upstreamId);
  if (id === upstreamId) throw new DbError('invalid_request', 'A node cannot follow itself', 400);
  const [targetStatus, upstreamStatus] = await Promise.all([nodeStatus(database, target), nodeStatus(database, upstream)]);
  if (!targetStatus.reachable || !upstreamStatus.reachable) throw new DbError('unreachable', 'Both nodes must be reachable');
  if (targetStatus.role !== 'standby') throw new DbError('not_standby', `${id} is a primary; re-join it with pg_rewind or a new base backup`);
  await createSlot(database, { node: upstreamId, slot: id });
  const address = replicationAddress(upstream);
  await withClient(database, target, 'admin', async client => {
    const pairs = parseConninfo((await client.query("SELECT current_setting('primary_conninfo') AS value")).rows[0].value).filter(([key]) => !['host', 'hostaddr', 'port'].includes(key));
    if (!pairs.some(([key]) => key === 'application_name')) pairs.push(['application_name', id]);
    await setting(client, 'primary_conninfo', formatConninfo([['host', address.host], ['port', String(address.port)], ...pairs]));
    await setting(client, 'primary_slot_name', id);
    await client.query('SELECT pg_reload_conf()');
  });
  // The WAL receiver restarts asynchronously; wait briefly so the answer reflects the outcome.
  for (let i = 0; i < 20; i++) {
    const state = await nodeStatus(database, target);
    if (state.receiver?.status === 'streaming' && state.receiver.senderHost === address.host) return { node: id, upstream: upstreamId, streaming: true };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { node: id, upstream: upstreamId, streaming: false, note: 'Настройка применена, но поток WAL ещё не установлен. Если standby опередил новый primary, нужен pg_rewind.' };
}
