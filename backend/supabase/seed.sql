-- ============================================================================
-- seed.sql — two companies that must never see each other.
--
-- Written as postgres (bypassing RLS) so the fixtures exist regardless of the
-- policies under test. Every test that follows runs as `authenticated`.
-- ============================================================================
set search_path = app, public;

-- ------------------------------------------------------------- people ------
insert into app.profiles (id, email, full_name, phone) values
  ('11111111-1111-1111-1111-111111111111', 'adeola@zenith.test',  'Adeola Bello',  '+2348024410119'),
  ('22222222-2222-2222-2222-222222222222', 'ngozi@zenith.test',   'Ngozi Okafor',  '+2348053378842'),
  ('33333333-3333-3333-3333-333333333333', 'grace@audit.test',    'Grace Aluko',   '+2348011122233'),
  ('44444444-4444-4444-4444-444444444444', 'femi@zenith.test',    'Femi Balogun',  '+2348099887766'),
  -- a completely unrelated company
  ('99999999-9999-9999-9999-999999999999', 'kola@rival.test',     'Kola Ade',      '+2348000000001')
on conflict (id) do nothing;

-- ---------------------------------------------------------- companies ------
insert into app.companies (id, name, registration_no, address, brand_hex) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Zenith Facilities Ltd', 'RC 1428907',
   '14 Adeola Odeku Street, Victoria Island, Lagos', '#5B4BE8'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Rival Logistics Ltd',   'RC 9900011',
   '9 Awolowo Road, Ikoyi, Lagos', '#0F7B6C')
on conflict (id) do nothing;

-- ----------------------------------------------------------- locations -----
insert into app.locations (id, company_id, name, kind, city, colour_hex) values
  ('c0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','Lagos HQ','physical','Victoria Island','#5B4BE8'),
  ('c0000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001','Ibadan Depot','physical','Bodija','#2E7FF0'),
  ('c0000000-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','Abuja Branch','physical','Wuse II','#0FA45E'),
  ('c0000000-0000-0000-0000-0000000000ff','aaaaaaaa-0000-0000-0000-000000000001','Virtual warehouse','virtual','No physical site','#9296AC'),
  ('d0000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002','Apapa Yard','physical','Apapa','#0F7B6C'),
  ('d0000000-0000-0000-0000-0000000000ff','bbbbbbbb-0000-0000-0000-000000000002','Virtual warehouse','virtual','No physical site','#9296AC')
on conflict (id) do nothing;

-- --------------------------------------------------------- memberships -----
-- Adeola: company-wide admin at Zenith.
-- Ngozi:  location manager, Abuja only.
-- Grace:  auditor, company-wide, read-only, but may see financials.
-- Femi:   requester at Lagos only.
-- Kola:   owner of the other company entirely.
insert into app.memberships (company_id, user_id, location_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111', null, 'owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','c0000000-0000-0000-0000-00000000000c','manager'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333', null, 'auditor'),
  ('aaaaaaaa-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','c0000000-0000-0000-0000-00000000000a','requester'),
  ('bbbbbbbb-0000-0000-0000-000000000002','99999999-9999-9999-9999-999999999999', null, 'owner')
on conflict do nothing;

-- ------------------------------------------------------------- catalog -----
insert into app.categories (id, company_id, name, icon, colour_hex) values
  ('e0000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','IT equipment','cpu','#5B4BE8'),
  ('f0000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002','IT equipment','cpu','#0F7B6C')
on conflict do nothing;

insert into app.sub_categories (id, company_id, category_id, name) values
  ('e1000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','e0000000-0000-0000-0000-00000000000a','All-in-one computers'),
  ('f1000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002','f0000000-0000-0000-0000-00000000000a','All-in-one computers')
on conflict do nothing;

insert into app.brands (id, company_id, name, colour_hex) values
  ('e2000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','Dell','#0076CE'),
  ('f2000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002','Dell','#0076CE')
on conflict do nothing;

insert into app.models
  (id, company_id, sub_category_id, brand_id, name, introduced_year,
   service_life_years, warranty_months, list_cost_minor, specs, spares) values
  ('e3000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-00000000000a','e2000000-0000-0000-0000-00000000000a',
   'OptiPlex 7410 AIO', 2023, 5, 36, 148000000,
   '[["Display","23.8 in FHD"],["Processor","Intel Core i5-13500T"],["Memory","16 GB DDR5"]]'::jsonb,
   array['Power adaptor','Stand hinge assembly'])
on conflict do nothing;

-- -------------------------------------------------------------- assets -----
insert into app.assets
  (id, company_id, tag, model_id, name, serial_no, status, location_id, holder, acquired_on) values
  ('a1000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','ZF-IT-0188',
   'e3000000-0000-0000-0000-00000000000a','Dell OptiPlex 7410 AIO','CN0X4K21-7742','active',
   'c0000000-0000-0000-0000-00000000000a','Finance desk 3','2023-09-27'),
  ('a1000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001','ZF-IT-0189',
   'e3000000-0000-0000-0000-00000000000a','Dell OptiPlex 7410 AIO','CN0X4K21-7743','active',
   'c0000000-0000-0000-0000-00000000000a','Finance desk 4','2023-09-27'),
  ('a1000000-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','ZF-IT-0190',
   'e3000000-0000-0000-0000-00000000000a','Dell OptiPlex 7410 AIO','CN0X4K21-7744','active',
   'c0000000-0000-0000-0000-00000000000a','Finance desk 5','2023-09-27'),
  -- one already sitting at Abuja, which is Ngozi's site
  ('a1000000-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001','ZF-IT-0191',
   'e3000000-0000-0000-0000-00000000000a','Dell OptiPlex 7410 AIO','CN0X4K21-7745','active',
   'c0000000-0000-0000-0000-00000000000c','Reception','2024-01-15'),
  -- and one belonging to the other company entirely
  ('b1000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002','RV-IT-0001',
   null,'Rival Dell OptiPlex','RV-SERIAL-0001','active',
   'd0000000-0000-0000-0000-00000000000a','Their front desk','2024-02-01')
on conflict do nothing;

insert into app.asset_financials (asset_id, company_id, purchase_cost_minor, invoice_ref, warranty_expires) values
  ('a1000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001', 148000000, 'INV-88213', '2026-12-31'),
  ('a1000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001', 148000000, 'INV-88213', '2026-12-31'),
  ('a1000000-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001', 148000000, 'INV-88213', '2026-12-31'),
  ('a1000000-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001', 162000000, 'INV-90114', '2027-01-15'),
  ('b1000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002', 999000000, 'RV-INV-1',  '2027-02-01')
on conflict do nothing;

-- ----------------------------------------------------------- a transfer ----
-- Approved and ready to dispatch: Lagos HQ -> Abuja Branch, three machines.
insert into app.transfers
  (id, company_id, reference, from_location, to_location, status, reason, requested_by, driver_name, vehicle_reg)
values
  ('11110000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','TR-0312',
   'c0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000c','approved',
   'Redeployment','11111111-1111-1111-1111-111111111111','Musa Danjuma','LND-472-XA')
on conflict do nothing;

insert into app.transfer_lines (company_id, transfer_id, asset_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11110000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-00000000000a'),
  ('aaaaaaaa-0000-0000-0000-000000000001','11110000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-00000000000b'),
  ('aaaaaaaa-0000-0000-0000-000000000001','11110000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-00000000000c')
on conflict do nothing;

-- ---------------------------------------------------------- stock items ----
insert into app.stock_items
  (id, company_id, sku, name, category, unit, is_divisible, reorder_point,
   unit_cost_minor, variance_tolerance_pct) values
  ('50000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
   'CON-AGO-001','Diesel (AGO)','Fuel','litres', true, 2000, 125000, 2.00),
  ('50000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001',
   'CON-PPE-021','Safety helmet','Safety','units', false, 40, 650000, 0),
  ('50000000-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001',
   'CON-OIL-002','Engine oil 15W-40','Fuel','litres', true, 120, 980000, 1.00),
  ('60000000-0000-0000-0000-00000000000a','bbbbbbbb-0000-0000-0000-000000000002',
   'RV-AGO-001','Their diesel','Fuel','litres', true, 500, 125000, 2.00)
on conflict do nothing;

-- A generator with a burn rate on its model, so fuel_reconciliation has
-- something to reason about. specs[0] is ["Fuel use","19.8 L/hr at full load"].
insert into app.models
  (id, company_id, sub_category_id, brand_id, name, introduced_year,
   service_life_years, warranty_months, service_interval, service_interval_unit,
   list_cost_minor, specs, spares, consumption_rate, consumption_unit) values
  ('e3000000-0000-0000-0000-00000000000b','aaaaaaaa-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-00000000000a','e2000000-0000-0000-0000-00000000000a',
   '1104A-44TG2 100 kVA', 2023, 12, 24, 250, 'hours', 485000000,
   '[["Fuel use","19.8 L/hr at full load"],["Output","100 kVA / 80 kW"]]'::jsonb,
   array['Air filter','Fuel filter'], 19.8, 'per_hour')
on conflict do nothing;

insert into app.assets
  (id, company_id, tag, model_id, name, serial_no, status, location_id,
   holder, acquired_on, meter_value, meter_unit) values
  ('a1000000-0000-0000-0000-00000000000e','aaaaaaaa-0000-0000-0000-000000000001','ZF-GEN-0041',
   'e3000000-0000-0000-0000-00000000000b','Perkins 100 kVA','PK-4471-A','active',
   'c0000000-0000-0000-0000-00000000000a','Facilities team','2023-03-14', 1000, 'hours')
on conflict do nothing;

-- ------------------------------------------------------ approval policies --
insert into app.approval_policies
  (company_id, request_type, name, priority, min_items, max_items, chain) values
  ('aaaaaaaa-0000-0000-0000-000000000001','transfer','Transfers under 5 assets',
   10, null, 5, array['manager']::app.role_type[]),
  ('aaaaaaaa-0000-0000-0000-000000000001','transfer','Transfers of 5 or more',
   20, 5, null, array['manager','admin']::app.role_type[])
on conflict do nothing;

insert into app.approval_policies
  (company_id, request_type, name, priority, min_amount_minor, max_amount_minor, chain) values
  ('aaaaaaaa-0000-0000-0000-000000000001','repair','Repairs under NGN 500,000',
   10, null, 50000000, array['manager']::app.role_type[]),
  ('aaaaaaaa-0000-0000-0000-000000000001','repair','Repairs of NGN 500,000 and above',
   20, 50000000, null, array['admin','owner']::app.role_type[]),
  ('aaaaaaaa-0000-0000-0000-000000000001','purchase','All purchase requests',
   10, null, null, array['manager','admin']::app.role_type[])
on conflict do nothing;
