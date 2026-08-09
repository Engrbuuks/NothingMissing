-- ============================================================================
-- 0006_inventory.sql
-- Consumable stock, and how a quantity is allowed to go down.
--
-- The central decision: a stock level is never a column you UPDATE. It is the
-- sum of an append-only ledger. If stock is a mutable number, "why is there
-- 640 litres?" has no answer — someone typed it. If it is a sum of movements,
-- every litre that left is attributable to an issue, a transfer, a spill or a
-- counted variance, with a name and a timestamp against it.
--
-- Fuel is the case that forces this. It reduces in three different ways and
-- only one of them is a deliberate act:
--
--   1. ISSUE      — someone drew 40 litres for a generator. Recorded.
--   2. CONSUMPTION — the generator burned it. Derived from the meter and the
--                    model's burn rate, never entered by hand.
--   3. SHRINKAGE  — evaporation, spillage, measurement error, theft. Nobody
--                    records this. It only ever appears as the gap between
--                    what the ledger says and what a physical count finds.
--
-- Shrinkage is the number worth having, and you cannot get it by subtracting
-- issues. You get it by counting, and posting the difference as its own
-- movement with a reason attached.
-- ============================================================================

do $$ begin
  create type app.stock_kind as enum (
    'receipt',        -- arrived from a purchase order
    'issue',          -- drawn for a job or an asset
    'return',         -- drawn but not used, put back
    'transfer_out',   -- left this location
    'transfer_in',    -- arrived at this location
    'count_adjust',   -- reconciliation against a physical count
    'loss'            -- spilled, expired, written off
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.count_status as enum ('open','submitted','posted','cancelled');
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------- stock items -----
create table if not exists app.stock_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references app.companies(id) on delete cascade,
  sku            text not null,
  name           text not null,
  category       text,
  -- litres, units, metres. Fuel is continuous, helmets are not; the unit is
  -- what tells the interface whether decimals make sense.
  unit           text not null,
  is_divisible   boolean not null default false,
  reorder_point  numeric(14,3) not null default 0 check (reorder_point >= 0),
  unit_cost_minor bigint check (unit_cost_minor >= 0),
  -- how much measurement error to tolerate before a variance is suspicious.
  -- A dipstick on a 2,000 litre tank is not accurate to the litre; a count of
  -- helmets is. Defaulting every item to zero tolerance floods you with noise.
  variance_tolerance_pct numeric(5,2) not null default 0
    check (variance_tolerance_pct between 0 and 100),
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, sku)
);

-- ----------------------------------------------------- the ledger ----------
create table if not exists app.stock_movements (
  id            bigserial primary key,
  company_id    uuid not null references app.companies(id) on delete cascade,
  item_id       uuid not null references app.stock_items(id) on delete restrict,
  location_id   uuid not null references app.locations(id) on delete restrict,
  kind          app.stock_kind not null,
  -- signed. Outbound movements are negative. There is no separate "direction"
  -- column to get out of step with the sign.
  qty           numeric(14,3) not null check (qty <> 0),
  balance_after numeric(14,3) not null,

  -- what it was for. An issue with none of these set is a smell.
  asset_id      uuid references app.assets(id) on delete set null,
  meter_reading numeric(12,2),        -- generator hours / vehicle km at issue
  job_ref       text,
  transfer_id   uuid,
  count_id      uuid,
  purchase_order_id uuid,

  reason        text,
  occurred_at   timestamptz not null default now(),
  actor_id      uuid references app.profiles(id),
  actor_label   text not null,

  constraint stock_sign_ck check (
    (kind in ('receipt','return','transfer_in') and qty > 0)
    or (kind in ('issue','transfer_out','loss') and qty < 0)
    or (kind = 'count_adjust')          -- a count can go either way
  )
);

create index if not exists stock_mv_item_loc_idx
  on app.stock_movements (company_id, item_id, location_id, occurred_at desc);
create index if not exists stock_mv_asset_idx
  on app.stock_movements (asset_id, occurred_at) where asset_id is not null;

-- The ledger is append-only for the same reason the audit log is: a corrected
-- issue is a further movement, not an edited one.
create or replace function app.stock_movements_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'stock movements are append-only: % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Post a correcting movement (return, loss or count_adjust) instead.';
end $$;

drop trigger if exists stock_mv_no_update on app.stock_movements;
create trigger stock_mv_no_update before update or delete on app.stock_movements
  for each row execute function app.stock_movements_immutable();

-- ------------------------------------------------- the derived balance -----
-- A cache, not a source of truth. app.verify_stock_integrity() below re-derives
-- it from the ledger and shouts if the two ever disagree.
create table if not exists app.stock_balances (
  company_id  uuid not null references app.companies(id) on delete cascade,
  item_id     uuid not null references app.stock_items(id) on delete cascade,
  location_id uuid not null references app.locations(id) on delete cascade,
  qty         numeric(14,3) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (item_id, location_id)
);

create index if not exists stock_bal_company_idx on app.stock_balances (company_id);

create or replace function app.stock_balance(p_item uuid, p_location uuid)
returns numeric
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select coalesce((select qty from app.stock_balances
                   where item_id = p_item and location_id = p_location), 0)
$$;

-- ======================================================= posting a move =====
-- The single entry point. Nothing else writes to the ledger, so the balance
-- cache and the negative-stock rule cannot be bypassed.
create or replace function app.post_stock_movement(
  p_item        uuid,
  p_location    uuid,
  p_kind        app.stock_kind,
  p_qty         numeric,              -- signed
  p_reason      text default null,
  p_asset       uuid default null,
  p_meter       numeric default null,
  p_job_ref     text default null,
  p_transfer    uuid default null,
  p_count       uuid default null,
  p_allow_negative boolean default false
) returns bigint
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_item    app.stock_items%rowtype;
  v_before  numeric(14,3);
  v_after   numeric(14,3);
  v_id      bigint;
  v_label   text;
begin
  select * into v_item from app.stock_items where id = p_item;
  if not found then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_item.company_id) then
    raise exception 'not permitted to move stock' using errcode = '42501';
  end if;
  if not app.can_access_location(v_item.company_id, p_location) then
    raise exception 'you cannot move stock at that location' using errcode = '42501';
  end if;
  if p_qty = 0 then
    raise exception 'a movement of zero is not a movement'
      using errcode = 'check_violation';
  end if;
  -- Whole units for indivisible items: half a helmet is a data-entry error.
  if not v_item.is_divisible and p_qty <> trunc(p_qty) then
    raise exception '% is counted in whole %, not fractions', v_item.name, v_item.unit
      using errcode = 'check_violation';
  end if;

  -- Serialise concurrent issues against the same item at the same site, so
  -- two people drawing the last 30 litres cannot both succeed.
  insert into app.stock_balances (company_id, item_id, location_id, qty)
  values (v_item.company_id, p_item, p_location, 0)
  on conflict (item_id, location_id) do nothing;

  select qty into v_before from app.stock_balances
   where item_id = p_item and location_id = p_location
   for update;

  v_after := v_before + p_qty;

  -- Negative stock means the ledger is describing something impossible. It is
  -- almost always an unrecorded receipt, so say so rather than just refusing.
  if v_after < 0 and not p_allow_negative then
    raise exception 'only % % of % at that location, cannot remove %',
      v_before, v_item.unit, v_item.name, abs(p_qty)
      using errcode = 'check_violation',
            hint = 'If the stock is physically there, a receipt was never recorded. Post the receipt first.';
  end if;

  select coalesce(pr.full_name, pr.email::text, 'System') into v_label
  from app.profiles pr where pr.id = auth.uid();
  v_label := coalesce(v_label, coalesce(current_setting('app.actor_label', true), 'System'));

  insert into app.stock_movements (
    company_id, item_id, location_id, kind, qty, balance_after,
    asset_id, meter_reading, job_ref, transfer_id, count_id,
    reason, actor_id, actor_label)
  values (
    v_item.company_id, p_item, p_location, p_kind, p_qty, v_after,
    p_asset, p_meter, p_job_ref, p_transfer, p_count,
    p_reason, auth.uid(), v_label)
  returning id into v_id;

  update app.stock_balances
     set qty = v_after, updated_at = now()
   where item_id = p_item and location_id = p_location;

  -- Crossing the reorder point is worth an audit row: it is the moment the
  -- clock starts on a purchase that has a lead time attached to it.
  if v_before >= v_item.reorder_point and v_after < v_item.reorder_point then
    perform app.log(v_item.company_id, 'stock fell below reorder point',
      'stock_items', p_item::text, v_item.sku,
      format('%s at %s: %s %s remaining against a %s point',
        v_item.name, (select name from app.locations where id = p_location),
        v_after, v_item.unit, v_item.reorder_point),
      'warn', p_location);
  end if;

  return v_id;
end $$;

-- ------------------------------------------------------ issuing stock ------
-- The deliberate reduction. Issuing fuel to a generator records the meter
-- reading at the same moment, which is what makes the burn-rate check below
-- possible at all.
create or replace function app.issue_stock(
  p_item     uuid,
  p_location uuid,
  p_qty      numeric,               -- positive; the sign is applied here
  p_asset    uuid default null,
  p_meter    numeric default null,
  p_job_ref  text default null,
  p_reason   text default null
) returns bigint
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_id bigint; v_item app.stock_items%rowtype;
begin
  if p_qty <= 0 then
    raise exception 'issue a positive quantity' using errcode = 'check_violation';
  end if;
  select * into v_item from app.stock_items where id = p_item;

  v_id := app.post_stock_movement(
    p_item, p_location, 'issue', -p_qty, p_reason, p_asset, p_meter, p_job_ref);

  -- Keep the asset's meter moving forward. A reading lower than the one on
  -- record is a typo or a replaced gauge; either way do not quietly accept it.
  if p_asset is not null and p_meter is not null then
    update app.assets
       set meter_value = greatest(meter_value, p_meter)
     where id = p_asset;
  end if;

  perform app.log(v_item.company_id, 'issued stock', 'stock_items',
    p_item::text, v_item.sku,
    format('%s %s of %s%s', p_qty, v_item.unit, v_item.name,
      coalesce(' to ' || (select tag from app.assets where id = p_asset),
               coalesce(' against ' || p_job_ref, ''))),
    'info', p_location);

  return v_id;
end $$;

-- ---------------------------------------------- moving stock between sites -
create or replace function app.transfer_stock(
  p_item uuid, p_from uuid, p_to uuid, p_qty numeric, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_item app.stock_items%rowtype;
begin
  if p_qty <= 0 then
    raise exception 'transfer a positive quantity' using errcode = 'check_violation';
  end if;
  if p_from = p_to then
    raise exception 'origin and destination are the same'
      using errcode = 'check_violation';
  end if;
  select * into v_item from app.stock_items where id = p_item;

  -- Both legs or neither. A transfer that debits one site and fails to credit
  -- the other invents a shortage out of nothing.
  perform app.post_stock_movement(p_item, p_from, 'transfer_out', -p_qty, p_reason);
  perform app.post_stock_movement(p_item, p_to,   'transfer_in',   p_qty, p_reason);

  perform app.log(v_item.company_id, 'transferred stock', 'stock_items',
    p_item::text, v_item.sku,
    format('%s %s of %s from %s to %s', p_qty, v_item.unit, v_item.name,
      (select name from app.locations where id = p_from),
      (select name from app.locations where id = p_to)),
    'info', p_to);

  return jsonb_build_object(
    'from_balance', app.stock_balance(p_item, p_from),
    'to_balance',   app.stock_balance(p_item, p_to));
end $$;

-- ================================================== physical stock counts ===
-- The only way shrinkage is ever discovered.
create table if not exists app.stock_counts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  location_id  uuid not null references app.locations(id) on delete restrict,
  reference    text not null,
  status       app.count_status not null default 'open',
  counted_by   text,                                 -- may be a link holder with no account
  counted_by_user uuid references app.profiles(id),
  submitted_at timestamptz,
  posted_at    timestamptz,
  posted_by    uuid references app.profiles(id),
  note         text,
  created_at   timestamptz not null default now(),
  unique (company_id, reference)
);

create table if not exists app.stock_count_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  count_id    uuid not null references app.stock_counts(id) on delete cascade,
  item_id     uuid not null references app.stock_items(id) on delete restrict,
  -- what the ledger said at the moment of counting, frozen so a later movement
  -- cannot rewrite the variance after the fact
  book_qty    numeric(14,3) not null,
  counted_qty numeric(14,3),          -- null means "not counted", not zero
  accepted    boolean,                -- manager's decision, per line
  note        text,
  unique (count_id, item_id)
);

-- Post an approved count: for every accepted line whose counted figure differs
-- from the book figure, write a count_adjust movement for exactly the gap.
create or replace function app.post_stock_count(p_count uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_c        app.stock_counts%rowtype;
  v_line     record;
  v_gap      numeric(14,3);
  v_adjusted int := 0;
  v_matched  int := 0;
  v_shrink   numeric(14,3) := 0;
begin
  select * into v_c from app.stock_counts where id = p_count for update;
  if not found then
    raise exception 'count not found' using errcode = 'no_data_found';
  end if;
  if v_c.status = 'posted' then
    raise exception 'count % has already been posted', v_c.reference
      using errcode = 'check_violation';
  end if;
  if not app.has_role(v_c.company_id, 'owner','admin','manager') then
    raise exception 'only a manager can post a count' using errcode = '42501';
  end if;
  if not app.can_access_location(v_c.company_id, v_c.location_id) then
    raise exception 'not your location' using errcode = '42501';
  end if;

  for v_line in
    select l.*, i.unit, i.name as item_name, i.sku
    from app.stock_count_lines l
    join app.stock_items i on i.id = l.item_id
    where l.count_id = p_count
      and l.counted_qty is not null      -- blank means not counted, never zero
      and coalesce(l.accepted, false)
  loop
    -- Re-read the live balance: something may have moved between counting and
    -- posting, and adjusting to a stale book figure would undo a real movement.
    v_gap := v_line.counted_qty - app.stock_balance(v_line.item_id, v_c.location_id);

    if v_gap = 0 then
      v_matched := v_matched + 1;
    else
      perform app.post_stock_movement(
        v_line.item_id, v_c.location_id, 'count_adjust', v_gap,
        format('Physical count %s by %s%s', v_c.reference,
          coalesce(v_c.counted_by, 'unknown'),
          coalesce(' — ' || v_line.note, '')),
        null, null, null, null, p_count, true);
      v_adjusted := v_adjusted + 1;
      if v_gap < 0 then v_shrink := v_shrink + v_gap; end if;
    end if;
  end loop;

  update app.stock_counts
     set status = 'posted', posted_at = now(), posted_by = auth.uid()
   where id = p_count;

  perform app.log(v_c.company_id, 'posted stock count', 'stock_counts',
    p_count::text, v_c.reference,
    format('%s line(s) matched, %s adjusted%s', v_matched, v_adjusted,
      case when v_shrink < 0
        then format(', net shrinkage %s', v_shrink) else '' end),
    case when v_adjusted > 0 then 'warn'::app.audit_tone else 'ok'::app.audit_tone end,
    v_c.location_id);

  return jsonb_build_object(
    'matched', v_matched, 'adjusted', v_adjusted, 'net_shrinkage', v_shrink);
end $$;

-- A burn rate is a number the system reasons with, so it belongs in a typed
-- column — not parsed out of a free-text specification string at read time.
-- "19.8 L/hr at full load" is for a human to read; regexing digits out of it
-- would happily return 1104 from a model number like "1104A-44TG2".
alter table app.models
  add column if not exists consumption_rate numeric(10,3)
    check (consumption_rate is null or consumption_rate > 0),
  add column if not exists consumption_unit text
    check (consumption_unit is null or consumption_unit in ('per_hour','per_km')),
  add column if not exists consumption_item_id uuid references app.stock_items(id);

comment on column app.models.consumption_rate is
  'Typed burn rate, e.g. 19.8 litres per hour. Never parsed from specs text.';

-- ============================================ the fuel question, answered ===
-- Issuing fuel tells you what left the tank. It does not tell you whether the
-- generator actually burned it. The catalog model carries a burn rate and the
-- asset carries a meter, so expected consumption is computable — and the gap
-- between issued and expected is the number that finds a leaking line, a
-- mis-set gauge, or a driver selling diesel at the gate.
create or replace function app.fuel_reconciliation(
  p_asset uuid,
  p_from  timestamptz default now() - interval '30 days',
  p_to    timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_a        app.assets%rowtype;
  v_rate     numeric;
  v_issued   numeric;
  v_m_start  numeric;
  v_m_end    numeric;
  v_hours    numeric;
  v_expected numeric;
  v_gap      numeric;
begin
  select * into v_a from app.assets where id = p_asset;
  if not found or not app.is_member(v_a.company_id) then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;

  -- Burn rate lives on the model as a number, so every unit of that model is
  -- measured the same way and buying six more needs no configuration.
  select m.consumption_rate into v_rate from app.models m where m.id = v_a.model_id;
  if v_rate is null then
    return jsonb_build_object(
      'asset', v_a.tag,
      'flag',  'no_burn_rate',
      'note',  'This model has no consumption rate set, so expected usage cannot be computed.');
  end if;

  select coalesce(sum(-qty), 0) into v_issued
  from app.stock_movements
  where asset_id = p_asset and kind = 'issue'
    and occurred_at between p_from and p_to;

  select min(meter_reading), max(meter_reading) into v_m_start, v_m_end
  from app.stock_movements
  where asset_id = p_asset and meter_reading is not null
    and occurred_at between p_from and p_to;

  v_hours    := coalesce(v_m_end, 0) - coalesce(v_m_start, 0);
  v_expected := round(coalesce(v_hours,0) * coalesce(v_rate,0), 3);
  v_gap      := round(v_issued - v_expected, 3);

  return jsonb_build_object(
    'asset',            v_a.tag,
    'issued',           v_issued,
    'meter_hours',      v_hours,
    'burn_rate',        v_rate,
    'expected',         v_expected,
    'unexplained',      v_gap,
    'unexplained_pct',  case when v_expected > 0
                          then round(v_gap / v_expected * 100, 1) else null end,
    -- A tolerance is essential. Load varies, gauges drift, and a system that
    -- cries theft at every 3% discrepancy gets ignored within a fortnight.
    'flag',             case
                          when v_expected = 0 then 'no_meter_data'
                          when abs(v_gap) / v_expected > 0.25 then 'investigate'
                          when abs(v_gap) / v_expected > 0.10 then 'watch'
                          else 'normal' end);
end $$;

comment on function app.fuel_reconciliation is
  'Issued versus expected consumption for a metered asset. The gap is the number worth looking at.';

-- A known limitation, stated rather than hidden: this compares fuel ISSUED to
-- fuel the engine could have BURNED, and those differ by whatever is sitting
-- in the tank at each end of the window. Over a single fill the opening top-up
-- makes the gap look large; over a month of runs it washes out. Reading tank
-- level at both ends would close it properly, and that is the next iteration.
-- Until then the flag is a prompt to look, never an accusation.

-- ------------------------------------------------- integrity self-check ----
-- The balance cache is derived data, so prove it still matches the ledger.
-- Run it nightly; a non-empty result is a bug, not a business problem.
create or replace function app.verify_stock_integrity(p_company uuid)
returns table (item_id uuid, location_id uuid, cached numeric, ledger numeric)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select b.item_id, b.location_id, b.qty,
         coalesce((select sum(m.qty) from app.stock_movements m
                   where m.item_id = b.item_id and m.location_id = b.location_id), 0)
  from app.stock_balances b
  where b.company_id = p_company
    and b.qty is distinct from coalesce(
      (select sum(m.qty) from app.stock_movements m
       where m.item_id = b.item_id and m.location_id = b.location_id), 0)
$$;

-- ---------------------------------------------------------------- RLS ------
alter table app.stock_items       enable row level security;
alter table app.stock_movements   enable row level security;
alter table app.stock_balances    enable row level security;
alter table app.stock_counts      enable row level security;
alter table app.stock_count_lines enable row level security;

alter table app.stock_items       force row level security;
alter table app.stock_movements   force row level security;
alter table app.stock_balances    force row level security;
alter table app.stock_counts      force row level security;
alter table app.stock_count_lines force row level security;

drop policy if exists stock_items_select on app.stock_items;
create policy stock_items_select on app.stock_items
  for select using ( app.is_member(company_id) );

drop policy if exists stock_items_insert on app.stock_items;
create policy stock_items_insert on app.stock_items
  for insert with check ( app.has_role(company_id, 'owner','admin','manager') );

drop policy if exists stock_items_update on app.stock_items;
create policy stock_items_update on app.stock_items
  for update
  using      ( app.has_role(company_id, 'owner','admin','manager') )
  with check ( app.has_role(company_id, 'owner','admin','manager') );

-- Movements and balances are readable within your location scope, and are
-- never written directly: app.post_stock_movement() is the only door.
drop policy if exists stock_mv_select on app.stock_movements;
create policy stock_mv_select on app.stock_movements
  for select using (
    app.is_member(company_id) and app.can_access_location(company_id, location_id)
  );

drop policy if exists stock_bal_select on app.stock_balances;
create policy stock_bal_select on app.stock_balances
  for select using (
    app.is_member(company_id) and app.can_access_location(company_id, location_id)
  );

drop policy if exists stock_counts_select on app.stock_counts;
create policy stock_counts_select on app.stock_counts
  for select using (
    app.is_member(company_id) and app.can_access_location(company_id, location_id)
  );

drop policy if exists stock_counts_insert on app.stock_counts;
create policy stock_counts_insert on app.stock_counts
  for insert with check (
    app.can_write(company_id) and app.can_access_location(company_id, location_id)
  );

drop policy if exists stock_counts_update on app.stock_counts;
create policy stock_counts_update on app.stock_counts
  for update
  using      ( app.can_write(company_id) and app.can_access_location(company_id, location_id) )
  with check ( app.can_write(company_id) and app.can_access_location(company_id, location_id) );

drop policy if exists stock_count_lines_select on app.stock_count_lines;
create policy stock_count_lines_select on app.stock_count_lines
  for select using ( app.is_member(company_id) );

drop policy if exists stock_count_lines_insert on app.stock_count_lines;
create policy stock_count_lines_insert on app.stock_count_lines
  for insert with check ( app.can_write(company_id) );

drop policy if exists stock_count_lines_update on app.stock_count_lines;
create policy stock_count_lines_update on app.stock_count_lines
  for update
  using      ( app.can_write(company_id) )
  with check ( app.can_write(company_id) );

revoke insert, update, delete on app.stock_movements from authenticated, anon;
revoke insert, update, delete on app.stock_balances  from authenticated, anon;

drop trigger if exists touch_stock_items on app.stock_items;
create trigger touch_stock_items before update on app.stock_items
  for each row execute function app.touch_updated_at();
