-- ============================================================================
-- A standing guard, not a test. Run in CI after the migrations: it fails if a
-- future migration adds a tenant table and forgets RLS, or writes a write
-- policy with USING but no WITH CHECK. Both mistakes are silent otherwise.
-- ============================================================================
do $$
declare v_bad text;
begin
  -- 1. every table in app must have RLS enabled and forced
  select string_agg(c.relname, ', ') into v_bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind = 'r'
    and (not c.relrowsecurity or not c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'tables without RLS enabled and forced: %', v_bad;
  end if;

  -- 2. every table carrying company_id must have at least one policy
  select string_agg(t.table_name, ', ') into v_bad
  from information_schema.columns t
  where t.table_schema = 'app' and t.column_name = 'company_id'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'app' and p.tablename = t.table_name);
  if v_bad is not null then
    raise exception 'tenant tables with no policy at all: %', v_bad;
  end if;

  -- 3. no INSERT or UPDATE policy may omit WITH CHECK. This is the one that
  --    lets a caller update a visible row into a shape they could not create.
  select string_agg(format('%s.%s', tablename, policyname), ', ') into v_bad
  from pg_policies
  where schemaname = 'app' and cmd in ('INSERT','UPDATE','ALL')
    and with_check is null;
  if v_bad is not null then
    raise exception 'write policies missing WITH CHECK: %', v_bad;
  end if;

  raise notice '  PASS  every app table has RLS forced, a policy, and WITH CHECK on writes';
end $$;

-- ============================================================================
-- Signature drift: CREATE OR REPLACE cannot change a function's parameters, so
-- adding one silently creates an overload and every existing call becomes
-- ambiguous. Catch it here rather than on deploy.
-- ============================================================================
do $$
declare v_bad text;
begin
  select string_agg(format('%s (%s overloads)', p.proname, cnt), ', ') into v_bad
  from (
    select p.proname, count(*) as cnt
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
    group by p.proname having count(*) > 1
  ) p;
  if v_bad is not null then
    raise exception 'functions with more than one signature (probable overload drift): %', v_bad;
  end if;
  raise notice '  PASS  no function in app has an accidental overload';
end $$;
