-- ============================================================================
-- 0026_sane_permissions.sql
-- Four things that were wrong, found by probing rather than by reading.
--
-- 1. A REQUESTER COULD RETIRE ANY ASSET. Retiring removes something from every
--    live register — it is the most destructive thing short of disposal, and
--    the most junior writing role could do it to anything in their scope. The
--    role exists so a site clerk can add what arrives and correct a holder,
--    not so they can quietly empty a depot.
--
-- 2. SERIALS AND TAGS COULD BE OVERWRITTEN SILENTLY. The serial is the one
--    field tying a database row to a physical object — it is what an auditor
--    matches against, and what a scan resolves. Letting anyone with write
--    access replace it means the register can be made to describe a different
--    machine entirely, with nothing on screen saying so.
--
-- 3. THE AUDIT LOG SHOWED "updated assets" WITH NO DETAIL. The before and
--    after states were captured correctly, so the trail was intact — but
--    nobody reading the log could see WHAT changed without querying jsonb by
--    hand. A trail nobody can read is a trail nobody checks.
--
-- 4. NOTHING STOPPED A COMPANY HAVING ONE OWNER AND NO WAY BACK. Several
--    owners were always allowed, but nothing encouraged it, and 0015 already
--    refuses to remove the last one. A company whose single owner leaves is
--    unreachable — so this adds a promote path and a visible warning.
-- ============================================================================

-- ------------------------------------------------- 1. retirement is senior --
-- Split the blanket update policy: everyone who may write can still edit an
-- asset, but changing status to retired requires manager or above.
create or replace function app.can_retire(p_company uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (
    select 1 from app.memberships m
    where m.company_id = p_company
      and m.user_id = (select auth.uid())
      and m.role in ('owner','admin','manager')
  )
$$;

grant execute on function app.can_retire(uuid) to authenticated;

-- ------------------------------------- 2. identity fields are write-once ----
-- A tag and a serial can be SET when they are empty, and corrected by an owner
-- or admin, but a requester cannot quietly swap one machine's identity for
-- another's. The trigger explains what to do instead rather than just refusing.
create or replace function app.assets_protect_identity()
returns trigger
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_senior boolean;
begin
  if tg_op <> 'UPDATE' then return new; end if;

  v_senior := app.has_role(new.company_id, 'owner', 'admin');

  -- Filling in a blank is always fine: somebody imported without serials and
  -- is now walking the floor with a scanner, which is exactly what we want.
  if old.serial_no is distinct from new.serial_no
     and old.serial_no is not null
     and not v_senior then
    raise exception 'Only an owner or admin can change a serial number that is already recorded.'
      using errcode = '42501',
            hint = 'The serial is what ties this row to a physical machine. If it is wrong, ask an admin — and if this is a different machine, add it as a new asset.';
  end if;

  if old.tag is distinct from new.tag and not v_senior then
    raise exception 'Only an owner or admin can change an asset tag.'
      using errcode = '42501',
            hint = 'The tag is printed on the label and quoted on waybills. Changing it breaks the link to documents already issued.';
  end if;

  -- Retiring is senior, wherever it is triggered from.
  if new.status = 'retired' and old.status <> 'retired'
     and not app.can_retire(new.company_id) then
    raise exception 'Your role cannot retire an asset.'
      using errcode = '42501',
            hint = 'Ask a manager. Retiring removes it from every live register, so it is deliberately not something a requester can do alone.';
  end if;

  -- Coming back from retired is senior too, or a retirement can be undone by
  -- the same person who should not have been able to do it.
  if old.status = 'retired' and new.status <> 'retired'
     and not app.can_retire(new.company_id) then
    raise exception 'Your role cannot bring a retired asset back.'
      using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists assets_identity_guard on app.assets;
create trigger assets_identity_guard
  before update on app.assets
  for each row execute function app.assets_protect_identity();

-- ---------------------------------------------- 3. a readable audit line ----
-- The generic tracker recorded before and after correctly but wrote no
-- summary, so the log read "updated assets" forever. This computes a plain
-- description of what actually changed, from the two states it already has.
create or replace function app.describe_change(p_before jsonb, p_after jsonb)
returns text
language plpgsql immutable as $$
declare
  v_key   text;
  v_parts text[] := '{}';
  v_from  text;
  v_to    text;
  -- Fields nobody needs narrated. updated_at changes on every write, and
  -- listing it would bury the change that matters.
  v_skip  text[] := array['updated_at','created_at','id','company_id','search_vector'];
  v_label text;
begin
  if p_before is null or p_after is null then return null; end if;

  for v_key in select jsonb_object_keys(p_after)
  loop
    continue when v_key = any(v_skip);
    v_from := p_before ->> v_key;
    v_to   := p_after  ->> v_key;
    continue when v_from is not distinct from v_to;

    v_label := replace(v_key, '_', ' ');
    v_label := replace(v_label, ' no', ' number');

    if v_from is null then
      v_parts := v_parts || format('%s set to %s', v_label, v_to);
    elsif v_to is null then
      v_parts := v_parts || format('%s cleared (was %s)', v_label, v_from);
    else
      v_parts := v_parts || format('%s changed from %s to %s', v_label, v_from, v_to);
    end if;
  end loop;

  if array_length(v_parts, 1) is null then return null; end if;

  -- Three changes read fine in a table cell; ten do not.
  if array_length(v_parts, 1) > 3 then
    return array_to_string(v_parts[1:3], ', ') ||
           format(' and %s other field(s)', array_length(v_parts, 1) - 3);
  end if;
  return array_to_string(v_parts, ', ');
end $$;

create or replace function app.audit_row_change()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid; v_ref text; v_loc uuid;
  v_before jsonb; v_after jsonb; v_action text; v_row jsonb; v_detail text;
begin
  v_row := to_jsonb(coalesce(new, old));
  v_company := (v_row ->> 'company_id')::uuid;
  if v_company is null then return coalesce(new, old); end if;

  if tg_nargs > 0 and tg_argv[0] is not null and tg_argv[0] <> '' then
    v_ref := v_row ->> tg_argv[0];
  end if;
  if tg_nargs > 1 and tg_argv[1] is not null and tg_argv[1] <> '' then
    v_loc := nullif(v_row ->> tg_argv[1], '')::uuid;
  end if;

  -- A deletion event cannot be filed at the location it just deleted.
  if tg_op = 'DELETE' and tg_table_name = 'locations' then
    v_loc := null;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'created ' || tg_table_name; v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_action := 'updated ' || tg_table_name;
    v_before := to_jsonb(old); v_after := to_jsonb(new);
    if v_before = v_after then return new; end if;
    -- What actually changed, in words, so the log is readable without
    -- querying jsonb by hand.
    v_detail := app.describe_change(v_before, v_after);
  else
    v_action := 'deleted ' || tg_table_name; v_before := to_jsonb(old);
  end if;

  perform app.log(
    v_company, v_action, tg_table_name, (v_row ->> 'id'), v_ref, v_detail,
    case tg_op when 'DELETE' then 'warn'::app.audit_tone else 'info'::app.audit_tone end,
    v_loc, v_before, v_after);

  return coalesce(new, old);
end $$;

-- ------------------------------------------------- 4. more than one owner ---
-- Always permitted; now there is a way to do it that does not require editing
-- the database, and a way to see when a company is one person away from being
-- unreachable.
create or replace function app.set_member_role(
  p_company uuid, p_user uuid, p_role app.role_type, p_location uuid default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_mine app.role_type; v_owners int; v_name text;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can change roles.' using errcode = '42501';
  end if;

  v_mine := app.role_in(p_company);

  -- An admin promoting somebody to owner could then be removed by them. Only
  -- an owner makes another owner.
  if p_role = 'owner' and v_mine <> 'owner' then
    raise exception 'Only an owner can make somebody else an owner.' using errcode = '42501';
  end if;

  -- And an admin cannot demote an owner, or the hierarchy is decorative.
  if exists (select 1 from app.memberships
             where company_id = p_company and user_id = p_user and role = 'owner')
     and v_mine <> 'owner' then
    raise exception 'Only an owner can change another owner''s role.' using errcode = '42501';
  end if;

  -- Demoting yourself when you are the only owner locks everybody out.
  if p_user = auth.uid() and p_role <> 'owner' then
    select count(*) into v_owners from app.memberships
     where company_id = p_company and role = 'owner' and user_id <> p_user;
    if v_owners = 0 then
      raise exception 'You are the only owner — make somebody else an owner first.'
        using errcode = 'check_violation',
              hint = 'A company with no owner cannot be administered by anyone.';
    end if;
  end if;

  update app.memberships
     set role = p_role,
         location_id = case when p_role in ('owner','admin') then null else p_location end
   where company_id = p_company and user_id = p_user;

  if not found then
    raise exception 'That person is not a member of this company.' using errcode = 'no_data_found';
  end if;

  select coalesce(full_name, email::text) into v_name from app.profiles where id = p_user;

  perform app.log(p_company, 'changed a role', 'memberships', p_user::text, v_name,
    format('now %s%s', p_role,
      coalesce(' at ' || (select name from app.locations where id = p_location), '')),
    (case when p_role = 'owner' then 'warn' else 'info' end)::app.audit_tone);

  return jsonb_build_object('ok', true, 'role', p_role);
end $$;

grant execute on function app.set_member_role(uuid, uuid, app.role_type, uuid) to authenticated;

-- What each role may actually do, as data rather than as prose scattered
-- through the interface. The People page reads this, so the description and
-- the behaviour cannot drift apart.
create or replace function app.role_capabilities()
returns table (role text, rank int, scope text, can_do text[], cannot_do text[])
language sql immutable as $$
  values
    ('owner', 1, 'Whole company',
     array['Everything an admin can do','Make and remove other owners','Close the company',
           'See all financial data'],
     array['Nothing — this is the top role']),
    ('admin', 2, 'Whole company',
     array['Add, edit and retire assets','Correct serials and tags','Approve transfers',
           'Invite people','Manage locations and the catalog','See financial data'],
     array['Make another owner','Close the company','Remove an owner']),
    ('manager', 3, 'Their locations only',
     array['Add and edit assets at their locations','Retire assets','Approve within their limit',
           'Review field submissions','Issue field links','Count and adjust stock'],
     array['See purchase costs','Change a serial already recorded','Invite people',
           'Touch other locations']),
    ('requester', 4, 'Their locations only',
     array['Add assets','Correct a holder or a note','Raise a transfer or a request',
           'Record stock movements'],
     array['Retire an asset','Change a serial or tag','Approve anything',
           'See purchase costs']),
    ('auditor', 5, 'Whole company, read only',
     array['Read everything including costs','Read the full audit log','Export'],
     array['Change anything at all'])
$$;

grant execute on function app.role_capabilities() to authenticated;
