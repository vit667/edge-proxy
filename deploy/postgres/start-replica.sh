#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" = '0' ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  exec gosu postgres bash /opt/start-replica.sh
fi
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  # A failed base backup is intentionally left for an operator to inspect, never deleted automatically.
  pg_basebackup --dbname="host=main port=5432 user=replicator application_name=$REPLICA_NAME" --pgdata="$PGDATA" --write-recovery-conf --wal-method=stream --slot="$REPLICA_NAME" --checkpoint=fast --no-password
  # The copy carries main's synchronous_standby_names. It is ignored during recovery but would block commits after a
  # promotion, so it is removed once here; later values set through the agent API (ALTER SYSTEM) are kept on restart.
  sed -i '/^synchronous_standby_names/d' "$PGDATA/postgresql.auto.conf"
fi
exec postgres -c hot_standby=on -c synchronous_commit=on
