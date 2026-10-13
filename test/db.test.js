import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConninfo, formatConninfo, parseSyncNames } from '../src/db.js';
import { validateDatabase } from '../src/db-config.js';

test('conninfo round-trips quoted values and keeps the password intact', () => {
  const pairs = parseConninfo(String.raw`user=replicator password='p a\'ss' host=main port=5432 application_name=replica`);
  assert.deepEqual(Object.fromEntries(pairs), { user: 'replicator', password: "p a'ss", host: 'main', port: '5432', application_name: 'replica' });
  assert.deepEqual(parseConninfo(formatConninfo(pairs)), pairs);
});

test('synchronous_standby_names forms are understood', () => {
  assert.deepEqual(parseSyncNames(''), { method: null, count: 0, names: [] });
  assert.deepEqual(parseSyncNames('FIRST 1 (standby)'), { method: 'FIRST', count: 1, names: ['standby'] });
  assert.deepEqual(parseSyncNames('ANY 2 (a, b, c)'), { method: 'ANY', count: 2, names: ['a', 'b', 'c'] });
  assert.deepEqual(parseSyncNames('a, b'), { method: 'FIRST', count: 1, names: ['a', 'b'] });
});

test('database node ids must be safe slot names', () => {
  assert.doesNotThrow(() => validateDatabase({ nodes: [{ id: 'main', host: '127.0.0.1', port: 5432 }] }));
  assert.throws(() => validateDatabase({ nodes: [{ id: "x'; DROP", host: '127.0.0.1', port: 5432 }] }));
  assert.throws(() => validateDatabase({ nodes: [{ id: 'main', host: 'bad host', port: 5432 }] }));
});
