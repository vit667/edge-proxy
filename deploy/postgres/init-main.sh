#!/usr/bin/env bash
set -euo pipefail
# Init sessions must not wait for a standby which has not taken its base backup yet.
export PGOPTIONS='-c synchronous_commit=off'
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=repl_password="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH LOGIN REPLICATION PASSWORD :'repl_password';
SELECT pg_create_physical_replication_slot('standby');
SELECT pg_create_physical_replication_slot('replica');
-- Enable synchronous replication only after initdb and database creation finish.
-- This file is read on the final server start, after the temporary init server exits.
ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (standby)';
SQL
printf '\nhost replication replicator all scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
