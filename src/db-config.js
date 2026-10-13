// Validation of the optional `database` section. Kept separate from db.js so the Worker bundle never imports `pg`.
//
// "database": {
//   "name": "edge",
//   "nodes": [
//     { "id": "main",    "host": "127.0.0.1", "port": 15432, "replicationHost": "main",    "replicationPort": 5432 },
//     { "id": "standby", "host": "127.0.0.1", "port": 15433, "replicationHost": "standby", "replicationPort": 5432 }
//   ]
// }
// host/port: how the agent reaches the node. replicationHost/Port: how the other PostgreSQL nodes reach it
// (inside a Docker network these differ). The node id is also its replication slot and application_name.

const port = value => Number.isInteger(value) && value > 0 && value < 65536;
const hostname = value => typeof value === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(value);

export function validateDatabase(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid database');
  if (value.name !== undefined && (typeof value.name !== 'string' || !/^[\w-]{1,63}$/.test(value.name))) throw new Error('Invalid database name');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 8) throw new Error('Provide 1–8 database nodes');
  const ids = new Set();
  for (const node of value.nodes) {
    // Lowercase identifiers are valid both as slot names and as synchronous_standby_names entries.
    if (typeof node.id !== 'string' || !/^[a-z][a-z0-9_]{0,40}$/.test(node.id) || ids.has(node.id)) throw new Error('Invalid database node id');
    if (!hostname(node.host) || !port(node.port)) throw new Error('Invalid database node address');
    if (node.replicationHost !== undefined && !hostname(node.replicationHost)) throw new Error('Invalid replicationHost');
    if (node.replicationPort !== undefined && !port(node.replicationPort)) throw new Error('Invalid replicationPort');
    ids.add(node.id);
  }
}
