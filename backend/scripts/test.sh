#!/usr/bin/env bash
# Rebuild the database from migrations, seed it, run every test, report.
# This is what CI runs. A failure anywhere aborts with a non-zero exit.
set -euo pipefail

DB="${DB:-asset_control_test}"
PSQL="psql -v ON_ERROR_STOP=1 -q -X"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

echo "▸ rebuilding $DB from scratch"
dropdb --if-exists "$DB"
createdb "$DB"

echo "▸ local auth shim"
PGOPTIONS="-c client_min_messages=warning" $PSQL -d "$DB" -f "$HERE/supabase/tests/00_shim.sql" >/dev/null

echo "▸ migrations"
for f in "$HERE"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  $PSQL -d "$DB" -f "$f" >/dev/null
done

echo "▸ structural guards"
if ! out=$(PGOPTIONS="-c client_min_messages=notice" $PSQL -d "$DB" -f "$HERE/scripts/verify_rls.sql" 2>&1); then
  echo "$out" | sed 's/^/    /'; exit 1
fi
echo "$out" | grep -oE 'PASS  .*' | sed 's/^PASS  /  ✓ /'

echo "▸ helpers and seed"
PGOPTIONS="-c client_min_messages=warning" $PSQL -d "$DB" -f "$HERE/supabase/tests/_helpers.sql" >/dev/null
PGOPTIONS="-c client_min_messages=warning" $PSQL -d "$DB" -f "$HERE/supabase/seed.sql" >/dev/null

echo "▸ tests"
FAILED=0
for f in "$HERE"/supabase/tests/[0-9]*.sql; do
  case "$(basename "$f")" in 00_shim.sql) continue ;; esac
  if ! out=$($PSQL -d "$DB" -f "$f" 2>&1); then
    echo "$out" | sed 's/^/    /'
    FAILED=1
    break
  fi
  echo "$out" | grep -oE '(──.*|PASS  .*)$' | sed 's/^──/\n──/' | sed 's/^PASS/  ✓ /' 
done

echo
if [ "$FAILED" -eq 0 ]; then
  COUNT=$($PSQL -d "$DB" -tAc "select 1" >/dev/null 2>&1; echo)
  echo "✓ all tests passed"
else
  echo "✗ tests failed"
  exit 1
fi
