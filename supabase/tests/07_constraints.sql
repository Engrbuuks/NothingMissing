-- ============================================================================
-- 07 — THE CONSTRAINTS THAT PROTECT THE REGISTER
-- These are the quiet ones. Each blocks a way a register drifts from reality.
-- ============================================================================
set role authenticated;
select t.heading('Register integrity constraints');

select t.as_user('11111111-1111-1111-1111-111111111111');

select t.raises($$
  insert into app.assets (company_id, tag, name, serial_no, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-DUP-1','Duplicate machine',
          'CN0X4K21-7742','active','c0000000-0000-0000-0000-00000000000a')
$$, 'the same serial cannot be registered twice', 'assets_serial_uq');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-IT-0188','Same tag again',
          'active','c0000000-0000-0000-0000-00000000000a')
$$, 'asset tags are unique within a company', 'assets_tag_uq');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-NOWHERE','Nowhere','active', null)
$$, 'an asset must be somewhere unless it is in transit', 'assets_location_ck');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-BOTH','Both','transit',
          'c0000000-0000-0000-0000-00000000000a')
$$, 'an asset in transit cannot also be on a register', 'assets_location_ck');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-CROSS','Cross tenant','active',
          'd0000000-0000-0000-0000-00000000000a')
$$, 'an asset cannot be placed in another company''s location');

select t.raises($$
  insert into app.transfers (company_id, reference, from_location, to_location, status)
  values ('aaaaaaaa-0000-0000-0000-000000000001','TR-SILLY',
          'c0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000a','draft')
$$, 'a transfer cannot start and end at the same place', 'endpoints');

select t.raises($$
  insert into app.transfers (company_id, reference, from_location, to_location, status, waybill_no)
  values ('aaaaaaaa-0000-0000-0000-000000000001','TR-EARLY',
          'c0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000c',
          'draft','WB-FORGED-0001')
$$, 'a waybill cannot exist before dispatch', 'waybill_ck');

select t.raises($$
  insert into app.locations (company_id, name, kind)
  values ('aaaaaaaa-0000-0000-0000-000000000001','Second warehouse','virtual')
$$, 'a company gets exactly one virtual warehouse', 'locations_one_virtual');

-- Exercise the constraint itself, not the RLS in front of it: an owner IS
-- allowed to update their company, so a failure here can only be the check.
select t.raises($$
  update app.companies set brand_hex = 'not-a-colour'
   where id = 'aaaaaaaa-0000-0000-0000-000000000001'
$$, 'brand colour must be a hex value', 'brand_hex');

select t.affects($$
  update app.companies set brand_hex = '#0F7B6C'
   where id = 'aaaaaaaa-0000-0000-0000-000000000001'
$$, 1, 'but a valid colour is accepted, proving the row was reachable');

select t.raises($$
  delete from app.memberships
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001' and role = 'owner'
$$, 'a company cannot be left without an owner', 'at least one owner');

reset role;
