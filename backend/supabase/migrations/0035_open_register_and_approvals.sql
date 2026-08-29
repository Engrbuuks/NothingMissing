-- ============================================================================
-- 0035_open_register_and_approvals.sql
--
-- Three things, all answering the same complaint: the register demanded
-- identifiers a real company does not have yet, and the approval chain was
-- silent.
--
-- 1. A tag is generated when none is given. Requiring one at the form was a
--    fiction anyway — `import_branch()` has generated tags since 0024, so the
--    same asset could be added by spreadsheet without a tag and refused by the
--    form for the same omission. One rule now, in the database, so every entry
--    path behaves identically.
--
-- 2. `description`, because "name" alone does not describe a thing somebody
--    has to recognise on a shelf a year later. Deliberately NOT a quantity
--    column — see the note above app.assets_fill_tag() for why a quantity is
--    entered at the form and becomes that many individually tagged assets.
--
-- 3. `request_notice()`, which returns everything an approval email needs
--    including WHO should receive it — the role of the step now waiting. The
--    application must not work that out for itself: it would be a second
--    opinion on the chain that could drift from the one the database enforces.
-- ============================================================================

-- ================================================================ columns ====
alter table app.assets add column if not exists description text;

comment on column app.assets.description is
  'Free text. What somebody needs to recognise this thing on a shelf: finish, '
  'size, colour, where it came from. Deliberately unstructured — the typed, '
  'comparable facts belong in category attributes (0022), not here.';

-- There is deliberately no `quantity` column on app.assets.
--
-- An asset is one physical thing with one tag, one serial, one location and
-- one history. A quantity column would mean a row reading "10 chairs" — and
-- the moment three of those chairs move to Abuja, that row cannot describe
-- what is true, because it holds one location_id. Splitting it then means
-- inventing three assets with no history, which is precisely the drift this
-- register exists to prevent. The same row could not carry three different
-- disposal dates, three meter readings, or three custody chains either.
--
-- Typing a quantity is still the right thing for a person to do. The form
-- takes it and creates that many assets, each individually tagged — which is
-- only comfortable now that tags generate themselves. Countable,
-- interchangeable things where nobody asks "where is that specific one?" are
-- stock, and belong in app.stock_items instead.

-- ============================================================ tag numbers ====
-- The old generator in import_branch() counted rows and added the row index:
--
--     'NM-' || lpad((select count(*) from assets ...) + i, 5, '0')
--
-- Counting is wrong as soon as anything is deleted. Delete asset 5 of 5 and
-- the next count is 4, so the next tag is NM-00005 — which already exists on a
-- label somewhere, or collides outright. It has to read the highest number
-- actually used, not how many rows there happen to be.
create or replace function app.next_asset_tag(p_company uuid)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_prefix text;
  v_next   int;
  v_tag    text;
  v_try    int := 0;
begin
  -- A company's own initials read better on a label than ours. Falls back to
  -- NM rather than failing, because a tag must always be issuable.
  select coalesce(nullif(regexp_replace(upper(c.name), '[^A-Z]', '', 'g'), ''), 'NM')
    into v_prefix
    from app.companies c where c.id = p_company;
  v_prefix := left(coalesce(v_prefix, 'NM'), 3);

  loop
    v_try := v_try + 1;

    -- Highest number already issued under this prefix, whatever the gaps.
    select coalesce(max(substring(a.tag from '^' || v_prefix || '-(\d+)$')::int), 0) + v_try
      into v_next
      from app.assets a
     where a.company_id = p_company
       and a.tag ~ ('^' || v_prefix || '-\d+$');

    v_tag := v_prefix || '-' || lpad(v_next::text, 5, '0');

    exit when not exists (
      select 1 from app.assets a
       where a.company_id = p_company and a.tag = v_tag
    );

    -- Two people adding an asset in the same instant both read the same max.
    -- The unique constraint is the real guard; this simply tries again rather
    -- than handing the second one an error it cannot act on.
    if v_try > 50 then
      v_tag := v_prefix || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS');
      exit;
    end if;
  end loop;

  return v_tag;
end $$;

revoke all on function app.next_asset_tag(uuid) from public;
grant execute on function app.next_asset_tag(uuid) to authenticated;

-- A trigger rather than a column default, because the default cannot see
-- company_id. BEFORE INSERT catches every path — the form, the import, a
-- server action, and anything added later — so no entry point can reintroduce
-- the requirement by forgetting to call a helper.
create or replace function app.assets_fill_tag()
returns trigger
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if new.tag is null or btrim(new.tag) = '' then
    new.tag := app.next_asset_tag(new.company_id);
  else
    new.tag := btrim(new.tag);
  end if;

  -- A blank serial is null, never an empty string. Two empty strings collide
  -- under the unique constraint; two nulls do not, and "we have not recorded
  -- the serial yet" is the normal state of a register being built.
  if new.serial_no is not null and btrim(new.serial_no) = '' then
    new.serial_no := null;
  end if;

  if new.description is not null and btrim(new.description) = '' then
    new.description := null;
  end if;

  return new;
end $$;

drop trigger if exists assets_fill_tag_trg on app.assets;
create trigger assets_fill_tag_trg
  before insert on app.assets
  for each row execute function app.assets_fill_tag();

-- The same blank-to-null rule on update, so clearing a serial in the form
-- releases it rather than storing '' and blocking the next asset.
create or replace function app.assets_blank_to_null()
returns trigger
language plpgsql set search_path = app, extensions, public, pg_temp as $$
begin
  if new.serial_no is not null and btrim(new.serial_no) = '' then
    new.serial_no := null;
  end if;
  if new.description is not null and btrim(new.description) = '' then
    new.description := null;
  end if;
  return new;
end $$;

drop trigger if exists assets_blank_to_null_trg on app.assets;
create trigger assets_blank_to_null_trg
  before update on app.assets
  for each row execute function app.assets_blank_to_null();

-- ======================================================= approval notices ====
-- Everything an approval email needs, including who should get it.
--
-- The recipient role is deliberately computed here rather than in TypeScript.
-- `decide_request()` enforces that step N needs role R; if the mailer worked
-- out the audience separately, the two could disagree and the wrong people
-- would be asked to approve something they cannot.
create or replace function app.request_notice(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r      app.requests%rowtype;
  v_step   app.request_steps%rowtype;
  v_total  int;
  v_role   text;
  v_raiser text;
  v_raiser_email text;
  v_loc    text;
  v_asset  text;
begin
  select * into v_r from app.requests where id = p_request;
  if not found then return null; end if;

  -- The caller must belong to the company. SECURITY DEFINER bypasses RLS, so
  -- without this any signed-in user could read any company's request.
  if not app.is_member(v_r.company_id) then
    raise exception 'not your request' using errcode = '42501';
  end if;

  select count(*) into v_total from app.request_steps where request_id = p_request;

  select * into v_step from app.request_steps
   where request_id = p_request and step_no = v_r.current_step;
  v_role := v_step.required_role::text;

  select p.full_name, p.email into v_raiser, v_raiser_email
    from app.profiles p where p.id = v_r.raised_by;

  select l.name into v_loc from app.locations l where l.id = v_r.location_id;
  select a.name into v_asset from app.assets a where a.id = v_r.asset_id;

  return jsonb_build_object(
    'company_id',  v_r.company_id,
    'reference',   v_r.reference,
    'kind',        v_r.kind,
    'status',      v_r.status,
    'title',       v_r.title,
    'detail',      v_r.detail,
    'location',    v_loc,
    'asset',       v_asset,
    'amount_minor',v_r.amount_minor,
    'step',        v_r.current_step,
    'of',          v_total,
    -- null once the chain is finished: there is nobody left to ask.
    'awaiting_role', case when v_r.status = 'pending' then v_role else null end,
    -- Who can actually sign this step. Seniority satisfies a junior step
    -- (`role_satisfies`: the enum is declared most-privileged first, so
    -- `role <= needed`), so emailing only the named role would leave an owner
    -- unaware of something they are entitled to approve. Derived here so it
    -- cannot drift from the rule `decide_request()` enforces.
    'notify_roles',
      case when v_r.status = 'pending' then (
        select coalesce(jsonb_agg(r::text), '[]'::jsonb)
          from unnest(enum_range(null::app.role_type)) r
         where r <= v_step.required_role
           and r::text in ('owner','admin','manager')
      ) else '[]'::jsonb end,
    'raised_by',     v_raiser,
    -- So the person who asked hears the outcome. They are frequently a
    -- requester, holding none of the roles an approval alert goes to.
    'raised_by_email', v_raiser_email
  );
end $$;

revoke all on function app.request_notice(uuid) from public;
grant execute on function app.request_notice(uuid) to authenticated;

-- ==================================================== register confidence ====
-- What replaces the estate value on the dashboard.
--
-- Purchase cost is a poor headline for this product. It is gated by role, so
-- the largest number on the page read "Restricted" for every manager and
-- clerk — the people who open it daily. It is the sum of what things cost when
-- bought, which drifts from what they are worth and answers a question the
-- register is not the authority on. And it does not move when the register
-- stops being true, which is the only thing this product promises.
--
-- Accounted-for does move. An asset is unaccounted when it belongs to no
-- register (in transit) or has an open discrepancy against it. Both are states
-- somebody can act on, and both are visible to every role.
create or replace function app.register_confidence(p_company uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_live      int;
  v_transit   int;
  v_disputed  int;
  v_unverified int;
  v_accounted int;
begin
  if not app.is_member(p_company) then
    raise exception 'not your company' using errcode = '42501';
  end if;

  select count(*) into v_live
    from app.assets a
   where a.company_id = p_company and a.status <> 'retired';

  select count(*) into v_transit
    from app.assets a
   where a.company_id = p_company and a.status = 'transit';

  -- Distinct, because one asset can collect several open discrepancies and
  -- must not be counted as missing twice.
  select count(distinct d.asset_id) into v_disputed
    from app.discrepancies d
    join app.assets a on a.id = d.asset_id
   where d.company_id = p_company
     and d.resolved_at is null
     and a.status <> 'retired'
     and a.status <> 'transit';

  -- Never seen by anybody since it was entered. Not counted as unaccounted —
  -- it is probably exactly where the register says — but it is the number
  -- that tells you how much of your confidence rests on nobody having checked.
  select count(*) into v_unverified
    from app.assets a
   where a.company_id = p_company
     and a.status <> 'retired'
     and not exists (
       select 1 from app.audit_events e
        where e.entity = 'assets' and e.entity_id = a.id::text
          and e.action in ('accepted a delivery','handed over an asset',
                           'reviewed a submission','returned to service')
     );

  v_accounted := greatest(v_live - v_transit - v_disputed, 0);

  return jsonb_build_object(
    'live',        v_live,
    'accounted',   v_accounted,
    'in_transit',  v_transit,
    'disputed',    v_disputed,
    'unverified',  v_unverified,
    'pct',         case when v_live = 0 then 100
                        else round((v_accounted::numeric / v_live) * 100)::int end
  );
end $$;

revoke all on function app.register_confidence(uuid) from public;
grant execute on function app.register_confidence(uuid) to authenticated;
