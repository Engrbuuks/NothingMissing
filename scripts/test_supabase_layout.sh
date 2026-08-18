#!/usr/bin/env bash
# Simulates Supabase's extension layout: pgcrypto ALREADY present in the
# `extensions` schema before our migrations run. This is the exact condition
# that produced "function digest(text, unknown) does not exist" in production
# while every local test passed.
set -euo pipefail
DB="${DB:-nm_supabase_sim}"
PSQL="psql -v ON_ERROR_STOP=1 -q -X"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

dropdb --if-exists "$DB"; createdb "$DB"

# Pre-create exactly what Supabase gives you on day one.
$PSQL -d "$DB" <<'SQL' >/dev/null
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to public;
SQL

$PSQL -d "$DB" -f "$HERE/supabase/tests/00_shim.sql" >/dev/null 2>&1
for f in "$HERE"/supabase/migrations/*.sql; do
  if ! err=$(PGOPTIONS="-c client_min_messages=warning" $PSQL -d "$DB" -f "$f" 2>&1); then
    echo "  FAIL  $(basename "$f")"; echo "$err" | grep ERROR | head -3 | sed 's/^/        /'; exit 1
  fi
done

# Then actually call the functions that need pgcrypto, as a normal user would.
$PSQL -d "$DB" -f "$HERE/supabase/tests/_helpers.sql" >/dev/null 2>&1
$PSQL -d "$DB" -f "$HERE/supabase/seed.sql" >/dev/null 2>&1

out=$($PSQL -d "$DB" -c "
  set role authenticated;
  select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',false);
  insert into app.link_holders (id, company_id, name, location_id)
  values ('80000000-0000-0000-0000-0000000000aa','aaaaaaaa-0000-0000-0000-000000000001',
          'Layout Test','c0000000-0000-0000-0000-00000000000a');
  select app.issue_location_link(
    'aaaaaaaa-0000-0000-0000-000000000001','c0000000-0000-0000-0000-00000000000a',
    '80000000-0000-0000-0000-0000000000aa', array['count']::app.link_verb[]) is not null as ok;
" 2>&1) || { echo "  FAIL  issue_location_link"; echo "$out" | grep ERROR | sed 's/^/        /'; exit 1; }

echo "  ✓  all migrations apply against Supabase's extension layout"
echo "  ✓  gen_random_bytes and digest resolve inside SECURITY DEFINER functions"
dropdb "$DB"
