-- ============================================================================
-- bootstrap.sql — create your first real company.
--
-- Run this ONCE, in the Supabase SQL Editor, AFTER migrations 0001–0010.
-- Do NOT run supabase/seed.sql: that creates two fictional companies for the
-- test suite and has no place in a live project.
--
-- Before running:
--   1. Create your own account. Supabase dashboard → Authentication → Users →
--      Add user → email and password → tick "Auto Confirm User".
--   2. Copy that user's UUID and paste it below.
--   3. Change the company name, address and slug to yours.
--
-- The slug is the subdomain: 'zenith' becomes zenith.nothingmissing.ng. It is
-- set once and cannot be changed afterwards, because changing it would break
-- every link already shared and every waybill already printed.
-- ============================================================================

do $$
declare
  -- ▼▼▼ EDIT THESE FOUR ▼▼▼
  v_user_id  uuid := '00000000-0000-0000-0000-000000000000';  -- from Authentication → Users
  v_email    text := 'you@yourcompany.com';
  v_name     text := 'Your Name';
  v_company  text := 'Zenith Facilities Ltd';
  -- ▲▲▲ EDIT THESE FOUR ▲▲▲

  v_slug     text := 'zenith';            -- becomes zenith.nothingmissing.ng
  v_rc       text := 'RC 0000000';
  v_address  text := '1 Some Street, Lagos';

  v_company_id uuid;
  v_hq         uuid;
  v_cat        uuid;
  v_sub        uuid;
  v_brand      uuid;
  v_model      uuid;
begin
  if v_user_id = '00000000-0000-0000-0000-000000000000' then
    raise exception 'Edit v_user_id first — take it from Authentication → Users.';
  end if;
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'No auth user with id %. Create the account first.', v_user_id;
  end if;

  -- The profile mirrors auth.users. Everything else keys off it.
  insert into app.profiles (id, email, full_name)
  values (v_user_id, v_email, v_name)
  on conflict (id) do update set email = excluded.email, full_name = excluded.full_name;

  if exists (select 1 from app.companies where lower(slug) = lower(v_slug)) then
    raise exception 'A company already holds the address %. Pick another.', v_slug;
  end if;

  insert into app.companies (name, registration_no, address, slug)
  values (v_company, v_rc, v_address, v_slug)
  returning id into v_company_id;

  -- Owner membership and the virtual warehouse. A company without an owner is
  -- unreachable; one without a virtual warehouse has nowhere to sweep assets.
  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_company_id, v_user_id, null, 'owner');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company_id, 'Virtual warehouse', 'virtual', 'No physical site', '#9296AC');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company_id, 'Head office', 'physical', 'Lagos', '#5B4BE8')
  returning id into v_hq;

  -- A minimal catalog, so the register has something to hang a model on. The
  -- specification lives on the model and every unit inherits it.
  insert into app.categories (company_id, name, icon, colour_hex)
  values (v_company_id, 'IT equipment', 'cpu', '#5B4BE8') returning id into v_cat;

  insert into app.sub_categories (company_id, category_id, name)
  values (v_company_id, v_cat, 'Laptops') returning id into v_sub;

  insert into app.brands (company_id, name, colour_hex)
  values (v_company_id, 'Dell', '#0076CE') returning id into v_brand;

  insert into app.models
    (company_id, sub_category_id, brand_id, name, introduced_year,
     service_life_years, warranty_months, list_cost_minor, specs)
  values
    (v_company_id, v_sub, v_brand, 'Latitude 5540', 2024, 4, 36, 134000000,
     '[["Display","15.6 in FHD"],["Memory","32 GB"],["Storage","512 GB SSD"]]'::jsonb)
  returning id into v_model;

  -- One asset, so the register is not empty on first sign-in and you can tell
  -- "no data" apart from "not connected".
  insert into app.assets
    (company_id, tag, model_id, name, serial_no, status, location_id, holder, acquired_on)
  values
    (v_company_id, 'NM-00001', v_model, 'Dell Latitude 5540', 'DEMO-0001',
     'active', v_hq, v_name, current_date);

  raise notice '───────────────────────────────────────────────';
  raise notice ' Company created: %', v_company;
  raise notice ' Sign in at:      https://%.nothingmissing.ng', v_slug;
  raise notice ' You are:         owner, all locations';
  raise notice '───────────────────────────────────────────────';
end $$;

-- Sanity check. Expect one company, one owner membership, two locations,
-- one asset.
select
  (select count(*) from app.companies)   as companies,
  (select count(*) from app.memberships) as memberships,
  (select count(*) from app.locations)   as locations,
  (select count(*) from app.assets)      as assets;
