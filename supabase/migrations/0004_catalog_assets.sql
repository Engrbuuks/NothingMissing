-- ============================================================================
-- 0004_catalog_assets.sql
-- The catalog (category -> type -> brand -> model) and the asset register.
--
-- Two decisions this file encodes:
--
--   1. A model holds the specification once and every unit inherits it. That
--      is what makes "how reliable is the Cummins C250" answerable instead of
--      a pattern you have to spot across rows that happen to be spelled alike.
--
--   2. Purchase cost lives in app.asset_financials, not on the asset row.
--      Postgres RLS gates rows, not columns. Splitting the table is what lets
--      a location manager read an asset and get no financial row back at all,
--      with no conditional select logic scattered through the application.
-- ============================================================================

do $$ begin
  create type app.asset_status as enum
    ('active','transit','repair','idle','retired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.disposal_reason as enum
    ('sold','scrapped','stolen','lost','donated','traded');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------- catalog -----
create table if not exists app.categories (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  name       text not null,
  icon       text,
  colour_hex text not null default '#5B4BE8' check (colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order int  not null default 0,
  unique (company_id, name)
);

create table if not exists app.sub_categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  category_id uuid not null references app.categories(id) on delete cascade,
  name        text not null,
  unique (category_id, name)
);

create table if not exists app.brands (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  name       text not null,
  colour_hex text,
  unique (company_id, name)
);

create table if not exists app.models (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references app.companies(id) on delete cascade,
  sub_category_id  uuid not null references app.sub_categories(id) on delete restrict,
  brand_id         uuid not null references app.brands(id) on delete restrict,
  name             text not null,
  introduced_year  int  check (introduced_year between 1900 and 2200),
  -- the specification, held once
  specs            jsonb not null default '[]'::jsonb,
  spares           text[] not null default '{}',
  notes            text,
  -- lifecycle, inherited by every unit
  service_life_years int  check (service_life_years between 1 and 100),
  warranty_months    int  check (warranty_months >= 0),
  service_interval   int,          -- hours, km or months
  service_interval_unit text check (service_interval_unit in ('hours','km','months')),
  list_cost_minor  bigint check (list_cost_minor >= 0),   -- kobo, never floats
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, brand_id, name)
);

create index if not exists models_company_idx on app.models (company_id);

-- Catalog rows must not cross tenants even though each carries company_id.
create or replace function app.catalog_same_company()
returns trigger language plpgsql as $$
declare v_bad int;
begin
  if tg_table_name = 'sub_categories' then
    select count(*) into v_bad from app.categories c
      where c.id = new.category_id and c.company_id <> new.company_id;
  elsif tg_table_name = 'models' then
    select count(*) into v_bad from app.sub_categories s
      where s.id = new.sub_category_id and s.company_id <> new.company_id;
    if v_bad = 0 then
      select count(*) into v_bad from app.brands b
        where b.id = new.brand_id and b.company_id <> new.company_id;
    end if;
  else
    v_bad := 0;
  end if;
  if v_bad > 0 then
    raise exception 'catalog rows must stay within one company'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

drop trigger if exists subcat_tenant_guard on app.sub_categories;
create trigger subcat_tenant_guard before insert or update on app.sub_categories
  for each row execute function app.catalog_same_company();

drop trigger if exists models_tenant_guard on app.models;
create trigger models_tenant_guard before insert or update on app.models
  for each row execute function app.catalog_same_company();

-- -------------------------------------------------------------- assets -----
create table if not exists app.assets (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  tag          text not null,
  model_id     uuid references app.models(id) on delete set null,
  name         text not null,
  serial_no    text,
  status       app.asset_status not null default 'active',
  -- null while in transit: the asset belongs to neither register
  location_id  uuid references app.locations(id) on delete restrict,
  holder       text,
  holder_user_id uuid references app.profiles(id),
  acquired_on  date,
  meter_value  numeric(12,2) not null default 0,
  meter_unit   text check (meter_unit in ('hours','km','months')),
  serviced_on  date,
  disposed_on  date,
  disposal_reason app.disposal_reason,
  disposal_ref    text,
  disposal_proceeds_minor bigint check (disposal_proceeds_minor >= 0),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint assets_tag_uq    unique (company_id, tag),
  -- the same physical machine cannot be registered twice
  constraint assets_serial_uq unique (company_id, serial_no),
  -- an asset is either on a register or explicitly in transit, never neither
  constraint assets_location_ck check (
    (status = 'transit' and location_id is null)
    or (status <> 'transit' and location_id is not null)
  ),
  constraint assets_disposal_ck check (
    (status = 'retired') or (disposed_on is null and disposal_reason is null)
  )
);

create index if not exists assets_company_loc_idx on app.assets (company_id, location_id);
create index if not exists assets_company_status_idx on app.assets (company_id, status);
create index if not exists assets_model_idx on app.assets (model_id);
create index if not exists assets_serial_idx on app.assets (company_id, serial_no)
  where serial_no is not null;

create or replace function app.assets_same_company()
returns trigger language plpgsql as $$
begin
  if new.location_id is not null and not exists (
    select 1 from app.locations l
    where l.id = new.location_id and l.company_id = new.company_id
  ) then
    raise exception 'asset location must belong to the same company'
      using errcode = 'foreign_key_violation';
  end if;
  if new.model_id is not null and not exists (
    select 1 from app.models m
    where m.id = new.model_id and m.company_id = new.company_id
  ) then
    raise exception 'asset model must belong to the same company'
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

drop trigger if exists assets_tenant_guard on app.assets;
create trigger assets_tenant_guard before insert or update on app.assets
  for each row execute function app.assets_same_company();

-- An asset must never be moved into an archived location.
create or replace function app.assets_reject_archived_location()
returns trigger language plpgsql as $$
begin
  if new.location_id is not null and exists (
    select 1 from app.locations l
    where l.id = new.location_id and l.archived_at is not null
  ) then
    raise exception 'cannot place an asset in an archived location'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists assets_archived_location_guard on app.assets;
create trigger assets_archived_location_guard before insert or update on app.assets
  for each row execute function app.assets_reject_archived_location();

-- --------------------------------------------------------- financials ------
create table if not exists app.asset_financials (
  asset_id        uuid primary key references app.assets(id) on delete cascade,
  company_id      uuid not null references app.companies(id) on delete cascade,
  purchase_cost_minor bigint check (purchase_cost_minor >= 0),
  supplier_id     uuid,
  invoice_ref     text,
  warranty_expires date,
  purchase_order_id uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS ------
alter table app.categories       enable row level security;
alter table app.sub_categories   enable row level security;
alter table app.brands           enable row level security;
alter table app.models           enable row level security;
alter table app.assets           enable row level security;
alter table app.asset_financials enable row level security;

alter table app.categories       force row level security;
alter table app.sub_categories   force row level security;
alter table app.brands           force row level security;
alter table app.models           force row level security;
alter table app.assets           force row level security;
alter table app.asset_financials force row level security;

do $$
declare t text;
begin
  foreach t in array array['categories','sub_categories','brands','models'] loop
    execute format($f$
      drop policy if exists %1$s_select on app.%1$s;
      create policy %1$s_select on app.%1$s
        for select using ( app.is_member(company_id) );

      drop policy if exists %1$s_insert on app.%1$s;
      create policy %1$s_insert on app.%1$s
        for insert with check ( app.has_role(company_id, 'owner','admin','manager') );

      drop policy if exists %1$s_update on app.%1$s;
      create policy %1$s_update on app.%1$s
        for update
        using      ( app.has_role(company_id, 'owner','admin','manager') )
        with check ( app.has_role(company_id, 'owner','admin','manager') );

      drop policy if exists %1$s_delete on app.%1$s;
      create policy %1$s_delete on app.%1$s
        for delete using ( app.has_role(company_id, 'owner','admin') );
    $f$, t);
  end loop;
end $$;

-- Assets: readable by anyone whose membership covers the location. An asset
-- in transit has no location, so it stays visible to the whole company —
-- which is correct, since it is precisely what both ends are waiting on.
drop policy if exists assets_select on app.assets;
create policy assets_select on app.assets
  for select using (
    app.is_member(company_id)
    and (location_id is null or app.can_access_location(company_id, location_id))
  );

drop policy if exists assets_insert on app.assets;
create policy assets_insert on app.assets
  for insert with check (
    app.can_write(company_id)
    and (location_id is null or app.can_access_location(company_id, location_id))
  );

-- USING controls which rows you may change; WITH CHECK controls what they may
-- become. Without the second, a manager could move an asset to a site they
-- have no rights over and the update would silently succeed.
drop policy if exists assets_update on app.assets;
create policy assets_update on app.assets
  for update
  using      ( app.can_write(company_id)
               and (location_id is null or app.can_access_location(company_id, location_id)) )
  with check ( app.can_write(company_id)
               and (location_id is null or app.can_access_location(company_id, location_id)) );

-- No delete policy. Assets are disposed of, which retires them and keeps the
-- history intact; they are never removed.

-- Financials: one permission, checked once, and no row comes back without it.
drop policy if exists financials_select on app.asset_financials;
create policy financials_select on app.asset_financials
  for select using ( app.can_see_financials(company_id) );

drop policy if exists financials_insert on app.asset_financials;
create policy financials_insert on app.asset_financials
  for insert with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists financials_update on app.asset_financials;
create policy financials_update on app.asset_financials
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

-- ------------------------------------------------------------- audit -------
drop trigger if exists audit_assets on app.assets;
create trigger audit_assets after insert or update or delete on app.assets
  for each row execute function app.audit_row_change('tag', 'location_id');

drop trigger if exists audit_models on app.models;
create trigger audit_models after insert or update or delete on app.models
  for each row execute function app.audit_row_change('name', '');

do $$
declare t text;
begin
  foreach t in array array['assets','models','asset_financials'] loop
    execute format(
      'drop trigger if exists touch_%1$s on app.%1$s;
       create trigger touch_%1$s before update on app.%1$s
       for each row execute function app.touch_updated_at();', t);
  end loop;
end $$;
