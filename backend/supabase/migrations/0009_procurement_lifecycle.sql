-- ============================================================================
-- 0009_procurement_lifecycle.sql
-- Suppliers, purchase orders, goods receipt, maintenance and disposal.
--
-- Two things worth stating up front.
--
-- Goods receipt is where a purchase becomes real assets, and it is the one
-- place a system quietly manufactures fiction: "12 chairs arrived" turning
-- into 12 identical rows nobody can ever tell apart. So receiving a serialised
-- line REQUIRES a serial per unit. If the goods genuinely have no nameplate,
-- the line must be marked unserialised explicitly — a decision someone makes,
-- not a gap the system papers over.
--
-- Disposal is the step auditors examine hardest, because it is where things
-- vanish. Each reason carries its own evidence requirement, enforced here
-- rather than left to the interface.
-- ============================================================================

do $$ begin
  create type app.po_status as enum
    ('draft','issued','part_received','received','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.po_line_kind as enum ('asset','stock','service');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ suppliers ----
create table if not exists app.suppliers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  name         text not null,
  email        citext,
  phone        text,
  address      text,
  supplies     text,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (company_id, name)
);

-- ------------------------------------------------------- purchase orders ---
create table if not exists app.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  reference    text not null,
  supplier_id  uuid references app.suppliers(id) on delete restrict,
  request_id   uuid references app.requests(id) on delete set null,
  destination  uuid not null references app.locations(id) on delete restrict,
  status       app.po_status not null default 'draft',
  expected_on  date,
  issued_at    timestamptz,
  received_at  timestamptz,
  raised_by    uuid references app.profiles(id),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, reference)
);

create table if not exists app.purchase_order_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  po_id         uuid not null references app.purchase_orders(id) on delete cascade,
  line_no       int  not null,
  kind          app.po_line_kind not null,
  description   text not null,
  qty           numeric(14,3) not null check (qty > 0),
  unit_cost_minor bigint not null default 0 check (unit_cost_minor >= 0),
  -- what this line becomes on receipt
  model_id      uuid references app.models(id) on delete set null,
  stock_item_id uuid references app.stock_items(id) on delete set null,
  -- explicit decision, never a silent default
  unserialised  boolean not null default false,
  qty_received  numeric(14,3) not null default 0 check (qty_received >= 0),
  unique (po_id, line_no),
  constraint po_line_target_ck check (
    (kind = 'asset'   and model_id is not null)
    or (kind = 'stock' and stock_item_id is not null)
    or (kind = 'service')
  )
);

-- Lead time measured from your own history, not from what the supplier said.
create or replace function app.supplier_lead_time(p_supplier uuid)
returns jsonb
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select jsonb_build_object(
    'orders',        count(*),
    'avg_days',      round(avg(extract(epoch from (received_at - issued_at)) / 86400)::numeric, 1),
    'worst_days',    round(max(extract(epoch from (received_at - issued_at)) / 86400)::numeric, 1))
  from app.purchase_orders
  where supplier_id = p_supplier and received_at is not null and issued_at is not null
    and app.is_member(company_id)
$$;

comment on function app.supplier_lead_time is
  'Computed from issue and receipt timestamps, which is how you discover the supplier promising two weeks has averaged three.';

-- ==================================================== receiving the goods ===
-- p_serials: [{"line_no":1,"serials":["CN0X-1","CN0X-2"]}, ...]
create or replace function app.receive_goods(
  p_po      uuid,
  p_serials jsonb default '[]'::jsonb,
  p_note    text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_po      app.purchase_orders%rowtype;
  v_line    record;
  v_entry   jsonb;
  v_serials jsonb;
  v_i       int;
  v_tag     text;
  v_asset   uuid;
  v_made    int := 0;
  v_stocked int := 0;
  v_seq     int;
begin
  select * into v_po from app.purchase_orders where id = p_po for update;
  if not found then
    raise exception 'purchase order not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_po.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.can_access_location(v_po.company_id, v_po.destination) then
    raise exception 'goods are being received at a location you do not cover'
      using errcode = '42501';
  end if;
  if v_po.status not in ('issued','part_received') then
    raise exception 'purchase order % is %, so nothing can be received against it',
      v_po.reference, v_po.status using errcode = 'check_violation';
  end if;

  for v_line in
    select * from app.purchase_order_lines
    where po_id = p_po and qty_received < qty order by line_no
  loop
    v_entry := (select e from jsonb_array_elements(p_serials) e
                where (e ->> 'line_no')::int = v_line.line_no);
    v_serials := coalesce(v_entry -> 'serials', '[]'::jsonb);

    if v_line.kind = 'asset' then
      -- The rule that stops fiction: a serialised line needs one serial per
      -- unit, or an explicit declaration that these have no nameplate.
      if not v_line.unserialised
         and jsonb_array_length(v_serials) <> v_line.qty::int then
        raise exception
          'line %: % unit(s) arriving but % serial(s) supplied',
          v_line.line_no, v_line.qty::int, jsonb_array_length(v_serials)
          using errcode = 'check_violation',
                hint = 'Scan or type every serial, or mark the line unserialised if the goods carry no nameplate.';
      end if;

      for v_i in 1 .. v_line.qty::int loop
        select coalesce(max(substring(tag from '[0-9]+$')::int), 0) + 1
          into v_seq
        from app.assets
        where company_id = v_po.company_id and tag like 'AC-%';

        v_tag := 'AC-' || lpad(v_seq::text, 5, '0');

        insert into app.assets
          (company_id, tag, model_id, name, serial_no, status, location_id,
           holder, acquired_on)
        values
          (v_po.company_id, v_tag, v_line.model_id, v_line.description,
           nullif(v_serials ->> (v_i - 1), ''), 'active', v_po.destination,
           'Unassigned', current_date)
        returning id into v_asset;

        insert into app.asset_financials
          (asset_id, company_id, purchase_cost_minor, purchase_order_id)
        values (v_asset, v_po.company_id, v_line.unit_cost_minor, p_po);

        v_made := v_made + 1;
      end loop;

    elsif v_line.kind = 'stock' then
      perform app.post_stock_movement(
        v_line.stock_item_id, v_po.destination, 'receipt', v_line.qty,
        format('Received against %s', v_po.reference));
      v_stocked := v_stocked + 1;
    end if;
    -- 'service' lines are a cost against the order and become nothing.

    update app.purchase_order_lines set qty_received = qty where id = v_line.id;
  end loop;

  update app.purchase_orders
     set status = 'received', received_at = now(), notes = coalesce(p_note, notes)
   where id = p_po;

  perform app.log(v_po.company_id, 'received goods', 'purchase_orders',
    p_po::text, v_po.reference,
    format('%s asset(s) created, %s stock line(s) received at %s', v_made, v_stocked,
      (select name from app.locations where id = v_po.destination)),
    'ok', v_po.destination);

  return jsonb_build_object('assets_created', v_made, 'stock_lines', v_stocked);
end $$;

-- ==================================================== scheduled maintenance =
create table if not exists app.maintenance_events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  asset_id    uuid not null references app.assets(id) on delete cascade,
  performed_on date not null default current_date,
  meter_at    numeric(12,2),
  kind        text,
  cost_minor  bigint check (cost_minor >= 0),
  vendor      text,
  note        text,
  logged_by   uuid references app.profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists maint_asset_idx on app.maintenance_events (asset_id, performed_on desc);

-- What is due, computed from the model's interval and the asset's meter. The
-- interval lives on the model, so buying six more of something schedules all
-- six without anyone configuring anything.
create or replace function app.maintenance_due(p_company uuid)
returns table (
  asset_id uuid, tag text, name text, location_id uuid,
  interval_size numeric, unit text, since_last numeric, pct numeric, state text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select a.id, a.tag, a.name, a.location_id,
         m.service_interval::numeric, m.service_interval_unit,
         (a.meter_value - coalesce(
            (select e.meter_at from app.maintenance_events e
             where e.asset_id = a.id order by e.performed_on desc limit 1), 0)),
         round((a.meter_value - coalesce(
            (select e.meter_at from app.maintenance_events e
             where e.asset_id = a.id order by e.performed_on desc limit 1), 0))
           / nullif(m.service_interval, 0) * 100, 1),
         case
           when m.service_interval is null then 'not_scheduled'
           when (a.meter_value - coalesce(
                  (select e.meter_at from app.maintenance_events e
                   where e.asset_id = a.id order by e.performed_on desc limit 1), 0))
                >= m.service_interval then 'overdue'
           when (a.meter_value - coalesce(
                  (select e.meter_at from app.maintenance_events e
                   where e.asset_id = a.id order by e.performed_on desc limit 1), 0))
                >= m.service_interval * 0.9 then 'due_soon'
           else 'ok'
         end
  from app.assets a
  join app.models m on m.id = a.model_id
  where a.company_id = p_company
    and a.status <> 'retired'
    and m.service_interval is not null
    and app.is_member(a.company_id)
    and (a.location_id is null or app.can_access_location(a.company_id, a.location_id))
$$;

create or replace function app.log_service(
  p_asset uuid, p_kind text default null, p_cost bigint default null,
  p_vendor text default null, p_note text default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_a app.assets%rowtype; v_id uuid;
begin
  select * into v_a from app.assets where id = p_asset;
  if not found then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  insert into app.maintenance_events
    (company_id, asset_id, performed_on, meter_at, kind, cost_minor, vendor, note, logged_by)
  values
    (v_a.company_id, p_asset, current_date, v_a.meter_value, p_kind, p_cost,
     p_vendor, p_note, auth.uid())
  returning id into v_id;

  update app.assets set serviced_on = current_date where id = p_asset;

  perform app.log(v_a.company_id, 'logged a service', 'assets', p_asset::text, v_a.tag,
    format('%s at meter %s%s', coalesce(p_kind, 'service'), v_a.meter_value,
      coalesce(' — ' || p_note, '')), 'ok', v_a.location_id);

  return v_id;
end $$;

-- Bringing an asset back is the step that gets forgotten, which is how things
-- sit marked In repair eighteen months after they came back.
create or replace function app.return_to_service(
  p_asset uuid, p_outcome text, p_cost bigint default null, p_note text default null
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_a app.assets%rowtype;
begin
  select * into v_a from app.assets where id = p_asset for update;
  if not found then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_a.status <> 'repair' then
    raise exception '% is %, not out for repair', v_a.tag, v_a.status
      using errcode = 'check_violation';
  end if;

  insert into app.maintenance_events
    (company_id, asset_id, meter_at, kind, cost_minor, note, logged_by)
  values (v_a.company_id, p_asset, v_a.meter_value, p_outcome, p_cost, p_note, auth.uid());

  if p_outcome ilike '%could not%' or p_outcome ilike '%beyond%' then
    -- Failed repair does not silently retire the asset: it must go through
    -- disposal so a reason and evidence are recorded.
    perform app.log(v_a.company_id, 'repair failed', 'assets', p_asset::text, v_a.tag,
      coalesce(p_note, 'beyond economic repair') || ' — take it through disposal',
      'warn', v_a.location_id);
  else
    update app.assets set status = 'active', holder = 'Back in service'
     where id = p_asset;
    perform app.log(v_a.company_id, 'returned asset to service', 'assets',
      p_asset::text, v_a.tag, p_outcome, 'ok', v_a.location_id);
  end if;
end $$;

-- ============================================================== disposal ====
create table if not exists app.disposals (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references app.companies(id) on delete cascade,
  reference      text not null,
  asset_id       uuid not null references app.assets(id) on delete restrict,
  reason         app.disposal_reason not null,
  disposed_on    date not null default current_date,
  proceeds_minor bigint check (proceeds_minor >= 0),
  book_value_minor bigint,
  evidence_ref   text,          -- police report, scrap note
  note           text,
  disposed_by    uuid references app.profiles(id),
  created_at     timestamptz not null default now(),
  unique (company_id, reference)
);

create or replace function app.dispose_asset(
  p_asset    uuid,
  p_reason   app.disposal_reason,
  p_proceeds bigint default null,
  p_evidence text default null,
  p_note     text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_a    app.assets%rowtype;
  v_ref  text;
  v_cost bigint;
  v_life int;
  v_age  int;
  v_book bigint;
begin
  select * into v_a from app.assets where id = p_asset for update;
  if not found then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_a.company_id, 'owner','admin') then
    raise exception 'only an owner or admin can dispose of an asset'
      using errcode = '42501';
  end if;
  if v_a.status = 'retired' then
    raise exception '% has already been disposed of', v_a.tag
      using errcode = 'check_violation';
  end if;
  if v_a.status = 'transit' then
    raise exception '% is in transit and cannot be disposed of mid-movement', v_a.tag
      using errcode = 'check_violation',
            hint = 'Receive it or resolve the discrepancy first.';
  end if;

  -- Evidence requirements, enforced here rather than left to a form. A theft
  -- or a scrapping with no reference is exactly the pattern an audit flags.
  if p_reason in ('stolen','scrapped')
     and coalesce(btrim(p_evidence), '') = '' then
    raise exception 'a % disposal needs a reference (police report or scrap note)',
      p_reason using errcode = 'check_violation';
  end if;
  if p_reason in ('sold','traded') and p_proceeds is null then
    raise exception 'record the proceeds for a % disposal', p_reason
      using errcode = 'check_violation';
  end if;

  select f.purchase_cost_minor into v_cost
    from app.asset_financials f where f.asset_id = p_asset;
  select m.service_life_years into v_life
    from app.models m where m.id = v_a.model_id;
  v_age  := greatest(0, extract(year from current_date)::int
                        - coalesce(extract(year from v_a.acquired_on)::int,
                                   extract(year from current_date)::int));
  v_book := case when v_cost is null or v_life is null then null
                 else greatest(0, (v_cost * (1 - least(1, v_age::numeric / v_life)))::bigint)
            end;

  v_ref := app.next_doc_number(v_a.company_id, 'disposal');

  insert into app.disposals
    (company_id, reference, asset_id, reason, proceeds_minor, book_value_minor,
     evidence_ref, note, disposed_by)
  values
    (v_a.company_id, v_ref, p_asset, p_reason, p_proceeds, v_book,
     p_evidence, p_note, auth.uid());

  update app.assets
     set status = 'retired', holder = null, disposed_on = current_date,
         disposal_reason = p_reason, disposal_ref = p_evidence,
         disposal_proceeds_minor = p_proceeds,
         location_id = (select id from app.locations
                        where company_id = v_a.company_id and kind = 'virtual')
   where id = p_asset;

  perform app.log(v_a.company_id, 'disposed of an asset', 'assets',
    p_asset::text, v_a.tag,
    format('%s%s%s', p_reason,
      case when p_proceeds is not null
        then format(', proceeds %s', p_proceeds / 100) else '' end,
      case when v_book is not null and p_proceeds is not null and p_proceeds < v_book
        then format(', loss on disposal %s', (v_book - p_proceeds) / 100) else '' end),
    case when p_reason in ('stolen','lost') then 'bad'::app.audit_tone
         else 'warn'::app.audit_tone end,
    v_a.location_id);

  return jsonb_build_object(
    'reference', v_ref, 'book_value_minor', v_book, 'proceeds_minor', p_proceeds,
    'loss_minor', case when v_book is not null and p_proceeds is not null
                    then greatest(0, v_book - p_proceeds) else null end);
end $$;

-- ---------------------------------------------------------------- RLS ------
alter table app.suppliers            enable row level security;
alter table app.purchase_orders      enable row level security;
alter table app.purchase_order_lines enable row level security;
alter table app.maintenance_events   enable row level security;
alter table app.disposals            enable row level security;

alter table app.suppliers            force row level security;
alter table app.purchase_orders      force row level security;
alter table app.purchase_order_lines force row level security;
alter table app.maintenance_events   force row level security;
alter table app.disposals            force row level security;

drop policy if exists suppliers_select on app.suppliers;
create policy suppliers_select on app.suppliers
  for select using ( app.is_member(company_id) );
drop policy if exists suppliers_write on app.suppliers;
create policy suppliers_write on app.suppliers
  for insert with check ( app.has_role(company_id, 'owner','admin') );
drop policy if exists suppliers_update on app.suppliers;
create policy suppliers_update on app.suppliers
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

-- Purchase orders carry prices, so they sit behind the financial permission
-- for reading, the same as asset costs do.
drop policy if exists po_select on app.purchase_orders;
create policy po_select on app.purchase_orders
  for select using ( app.can_see_financials(company_id) );
drop policy if exists po_insert on app.purchase_orders;
create policy po_insert on app.purchase_orders
  for insert with check ( app.has_role(company_id, 'owner','admin') );
drop policy if exists po_update on app.purchase_orders;
create policy po_update on app.purchase_orders
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists po_lines_select on app.purchase_order_lines;
create policy po_lines_select on app.purchase_order_lines
  for select using ( app.can_see_financials(company_id) );
drop policy if exists po_lines_insert on app.purchase_order_lines;
create policy po_lines_insert on app.purchase_order_lines
  for insert with check ( app.has_role(company_id, 'owner','admin') );
drop policy if exists po_lines_update on app.purchase_order_lines;
create policy po_lines_update on app.purchase_order_lines
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

-- Maintenance history is operational, not financial: everyone sees it.
drop policy if exists maint_select on app.maintenance_events;
create policy maint_select on app.maintenance_events
  for select using ( app.is_member(company_id) );
drop policy if exists maint_insert on app.maintenance_events;
create policy maint_insert on app.maintenance_events
  for insert with check ( app.can_write(company_id) );

drop policy if exists disposals_select on app.disposals;
create policy disposals_select on app.disposals
  for select using ( app.is_member(company_id) );

-- Disposals are written only through dispose_asset(), so the evidence rules
-- cannot be sidestepped by inserting a row directly.
revoke insert, update, delete on app.disposals from authenticated, anon;

drop trigger if exists audit_po on app.purchase_orders;
create trigger audit_po after insert or update on app.purchase_orders
  for each row execute function app.audit_row_change('reference', 'destination');

drop trigger if exists touch_po on app.purchase_orders;
create trigger touch_po before update on app.purchase_orders
  for each row execute function app.touch_updated_at();
