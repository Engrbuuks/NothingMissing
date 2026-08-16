-- ============================================================================
-- 0028_sanity_constraints.sql
-- Two gaps found by probing rather than reading, plus one same-location guard.
--
-- Most constraints held: stock cannot go negative, costs cannot be negative,
-- reorder points cannot be negative, blank names are refused, duplicate tags
-- and serials are refused. These three were not covered.
--
-- 1. AN ASSET COULD BE ACQUIRED IN 2027. A future acquisition date makes the
--    age profile nonsense, puts the asset outside every depreciation window,
--    and reads as a data-entry slip nobody catches — because nothing on screen
--    says a date is impossible.
--
-- 2. A METER READING COULD GO BACKWARDS. 5,000 hours to 100 hours, silently.
--    This is the serious one: the fuel reconciliation compares litres issued
--    against hours run, so a meter that drops makes a genuine loss look like a
--    surplus, and the one check designed to catch theft stops working.
--
--    Meters do legitimately reset — an engine is replaced, a dashboard is
--    swapped. So this is not a refusal. It requires the drop to be recorded
--    with a reason, which is the difference between an event and a mistake.
--
-- 3. A TRANSFER FROM A PLACE TO ITSELF. Harmless but meaningless, and it
--    produces a waybill that reads as an error to whoever receives it.
-- ============================================================================

-- ------------------------------------------------------- acquisition date --
-- Tomorrow is allowed, because somebody entering a delivery arriving in the
-- morning is doing something reasonable. A year out is a typo.
alter table app.assets
  drop constraint if exists assets_acquired_sane;
alter table app.assets
  add constraint assets_acquired_sane check (
    acquired_on is null
    or (acquired_on >= date '1970-01-01' and acquired_on <= current_date + 1)
  ) not valid;

-- NOT VALID so existing rows are not rejected on migration — a register
-- imported with a bad date should be correctable rather than block the deploy.
-- New and updated rows are checked from now on.

-- ------------------------------------------------------------ meter drops --
alter table app.assets
  add column if not exists meter_reset_at timestamptz,
  add column if not exists meter_reset_note text;

create or replace function app.assets_meter_guard()
returns trigger
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.meter_value is null or old.meter_value is null then return new; end if;
  if new.meter_value >= old.meter_value then return new; end if;

  -- A drop is only accepted alongside a note explaining it, set in the same
  -- statement. Engines are replaced and dashboards are swapped; those are
  -- events worth recording, not errors to hide.
  if new.meter_reset_note is distinct from old.meter_reset_note
     and nullif(btrim(coalesce(new.meter_reset_note, '')), '') is not null then
    new.meter_reset_at := now();
    perform app.log(new.company_id, 'recorded a meter reset', 'assets', new.id::text,
      new.tag,
      format('%s went from %s to %s %s — %s',
        new.name, old.meter_value, new.meter_value,
        coalesce(new.meter_unit, ''), new.meter_reset_note),
      'warn', new.location_id);
    return new;
  end if;

  raise exception 'A meter cannot go backwards, from % to %.', old.meter_value, new.meter_value
    using errcode = 'check_violation',
          hint = 'If the engine or dashboard was replaced, record the reason in the meter reset note and it will be accepted and logged. The fuel check compares litres issued against hours run, so an unexplained drop makes a real loss look like a surplus.';
end $$;

drop trigger if exists assets_meter_guard on app.assets;
create trigger assets_meter_guard
  before update of meter_value on app.assets
  for each row execute function app.assets_meter_guard();

-- ------------------------------------------------ transfer to itself -------
alter table app.transfers
  drop constraint if exists transfers_route_distinct;
alter table app.transfers
  add constraint transfers_route_distinct
  check (from_location is distinct from to_location) not valid;

-- ---------------------------------------------------- service dates --------
-- The maintenance table calls it performed_on, not occurred_on. A service
-- logged in the future breaks "days since last service" arithmetic.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'app' and table_name = 'maintenance_events'
      and column_name = 'performed_on'
  ) then
    execute 'alter table app.maintenance_events drop constraint if exists maintenance_date_sane';
    execute 'alter table app.maintenance_events add constraint maintenance_date_sane
             check (performed_on <= current_date + 1) not valid';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A note on NOT VALID.
--
-- Every constraint above is added NOT VALID deliberately. A company that has
-- already imported a register with one bad date should be able to deploy this
-- and then fix the row — not have the migration refuse to apply and leave them
-- stuck with no way forward. New writes are checked immediately; the backlog
-- can be validated later with:
--
--   alter table app.assets validate constraint assets_acquired_sane;
--
-- which fails loudly listing what needs correcting, at a moment of somebody's
-- choosing rather than mid-deploy.
-- ---------------------------------------------------------------------------

-- What needs correcting, so somebody can find it rather than discovering it
-- when a constraint is validated.
create or replace function app.data_health(p_company uuid)
returns table (issue text, count int, detail text)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select 'Acquisition date in the future',
         count(*)::int,
         'The age profile and any depreciation will be wrong for these.'
  from app.assets
  where company_id = p_company and acquired_on > current_date + 1
  having count(*) > 0

  union all
  select 'No serial number',
         count(*)::int,
         'These can never be matched by a scan or verified against a physical label.'
  from app.assets
  where company_id = p_company and serial_no is null and status <> 'retired'
  having count(*) > 0

  union all
  select 'Not linked to a catalog model',
         count(*)::int,
         'No specification, no service interval and no warranty term is inherited.'
  from app.assets
  where company_id = p_company and model_id is null and status <> 'retired'
  having count(*) > 0

  union all
  -- stock_counts is per location, with the items on count_lines. A location
  -- that has never been counted is the thing worth surfacing.
  select 'Location never stock-counted',
         count(*)::int,
         'Balances there come only from receipts and issues, never verified against a shelf.'
  from app.locations l
  where l.company_id = p_company and l.archived_at is null and l.kind <> 'virtual'
    and exists (select 1 from app.stock_balances b where b.location_id = l.id and b.qty <> 0)
    and not exists (select 1 from app.stock_counts sc where sc.location_id = l.id)
  having count(*) > 0

  union all
  select 'Location with no assets and no stock',
         count(*)::int,
         'Either it is new, or something was moved out and never replaced.'
  from app.locations l
  where l.company_id = p_company and l.archived_at is null and l.kind <> 'virtual'
    and not exists (select 1 from app.assets a where a.location_id = l.id)
    and not exists (select 1 from app.stock_balances b where b.location_id = l.id and b.qty <> 0)
  having count(*) > 0
$$;

grant execute on function app.data_health(uuid) to authenticated;
