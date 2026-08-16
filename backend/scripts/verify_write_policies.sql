-- ============================================================================
-- Every table the application writes to directly must have a policy for that
-- operation. A write to a table with RLS enabled and no matching policy fails
-- at runtime with "violates row-level security" — which a user reads as the
-- application being broken.
--
-- This queries pg_policies rather than grepping the migrations, because many
-- policies are generated in a loop and no amount of regex will see them. An
-- earlier text-based version reported four working tables as broken, which is
-- worse than not checking at all.
-- ============================================================================
do $$
declare
  r record;
  v_bad text[] := '{}';
begin
  for r in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'
      and c.relkind = 'r'
      and c.relrowsecurity
      -- Tables the app writes to through PostgREST rather than a function.
      and c.relname in (
        'assets','asset_financials','categories','sub_categories','brands',
        'models','stock_items','suppliers','locations','view_preferences',
        'companies','profiles','notifications','attachments'
      )
  loop
    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'app' and p.tablename = r.table_name
        and p.cmd in ('INSERT','ALL')
    ) then
      v_bad := v_bad || (r.table_name || ' (no INSERT policy)');
    end if;

    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'app' and p.tablename = r.table_name
        and p.cmd in ('UPDATE','ALL')
    ) then
      v_bad := v_bad || (r.table_name || ' (no UPDATE policy)');
    end if;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception 'tables the app writes to with no matching policy: %',
      array_to_string(v_bad, ', ');
  end if;

  raise notice '  ✓  every directly-written table has insert and update policies';
end $$;
