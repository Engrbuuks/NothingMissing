-- ============================================================================
-- Every named argument the application passes to an RPC must exist in the
-- function's signature. Postgres matches named arguments exactly, so a typo
-- produces "function app.x(...) does not exist" — which reaches the user as an
-- opaque failure with no clue what went wrong.
--
-- This reads pg_proc rather than parsing the migration text. A text-based
-- version reported six working calls as broken, because it could not handle an
-- argument whose default contains a comma (`DEFAULT NULL::uuid`). Checking
-- against the database is the only version worth having.
--
-- The expected list below is generated from the application by
-- scripts/dump_rpc_calls.sh and pasted in, so this stays a plain SQL check
-- that runs in the same place as the others.
-- ============================================================================
do $$
declare
  r record;
  v_bad text[] := '{}';
begin
  for r in
    select * from (values
      ('signup_company',      array['p_company_name','p_slug','p_full_name','p_registration','p_address']),
      ('invite_member',       array['p_company','p_email','p_role','p_location']),
      ('accept_invitation',   array['p_token']),
      ('import_branch',       array['p_company','p_location_name','p_rows','p_commit','p_location_id','p_city']),
      ('issue_stock',         array['p_item','p_location','p_qty','p_asset','p_meter','p_job_ref','p_reason']),
      ('submit_from_link',    array['p_token','p_kind','p_note','p_device','p_lines','p_asset','p_fault','p_dest','p_meter']),
      ('set_member_role',     array['p_company','p_user','p_role','p_location']),
      ('set_company_theme',   array['p_company','p_brand','p_accent','p_mode','p_footer','p_show_logo']),
      ('fuel_fleet',          array['p_company','p_from','p_to']),
      ('update_my_profile',   array['p_full_name','p_phone','p_job_title']),
      ('rename_company',      array['p_company','p_name']),
      ('apply_attribute_pack',array['p_company','p_pack'])
    ) as t(fn, args)
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'app' and p.proname = r.fn) then
      v_bad := v_bad || (r.fn || ' does not exist');
      continue;
    end if;

    declare v_actual text[];
    begin
      select coalesce(p.proargnames, '{}') into v_actual
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = r.fn
      limit 1;

      if not (r.args <@ v_actual) then
        v_bad := v_bad || format('%s: app passes %s, function accepts %s',
          r.fn,
          array_to_string(array(select unnest(r.args) except select unnest(v_actual)), ','),
          array_to_string(v_actual, ','));
      end if;
    end;
  end loop;

  if array_length(v_bad, 1) > 0 then
    raise exception 'rpc argument mismatches: %', array_to_string(v_bad, ' | ');
  end if;

  raise notice '  ✓  every rpc argument the app passes exists in its function';
end $$;
