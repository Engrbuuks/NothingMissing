-- ============================================================================
-- 02 — ROLE AND LOCATION SCOPE
-- A location manager sees their site. An auditor reads everything and writes
-- nothing. A requester cannot approve. Costs are one permission, checked once.
-- ============================================================================
set role authenticated;
select t.heading('Role and location scope');

-- --- Ngozi: manager, Abuja only -------------------------------------------
select t.as_user('22222222-2222-2222-2222-222222222222');

select t.eq((select count(*)::int from app.assets), 1,
            'Abuja manager sees only assets at her own site');
select t.eq((select tag from app.assets limit 1), 'ZF-IT-0191',
            'and it is the right one');
select t.eq((select count(*)::int from app.asset_financials), 0,
            'a location manager gets no financial rows at all, not blanked ones');
select t.ok(not app.can_see_financials('aaaaaaaa-0000-0000-0000-000000000001'),
            'can_see_financials() is false for a manager');
select t.ok(app.can_access_location('aaaaaaaa-0000-0000-0000-000000000001',
              'c0000000-0000-0000-0000-00000000000c'),
            'can act at her own location');
select t.ok(not app.can_access_location('aaaaaaaa-0000-0000-0000-000000000001',
              'c0000000-0000-0000-0000-00000000000a'),
            'cannot act at Lagos HQ');

-- She may move her own asset around her own site.
update app.assets set holder = 'Reception desk 2'
 where id = 'a1000000-0000-0000-0000-00000000000d';
select t.eq((select holder from app.assets where id = 'a1000000-0000-0000-0000-00000000000d'),
            'Reception desk 2', 'a manager can update an asset at her site');

-- But she may not push it to a site she has no rights over. This is the case
-- a `for all using(...)` policy with no WITH CHECK would let through.
select t.raises($$
  update app.assets set location_id = 'c0000000-0000-0000-0000-00000000000b'
   where id = 'a1000000-0000-0000-0000-00000000000d'
$$, 'WITH CHECK blocks moving an asset to an unauthorised location');

select t.raises($$
  insert into app.locations (company_id, name, kind)
  values ('aaaaaaaa-0000-0000-0000-000000000001','Sneaky Site','physical')
$$, 'a manager cannot create locations');

-- --- Grace: auditor, company-wide, read-only ------------------------------
select t.as_user('33333333-3333-3333-3333-333333333333');

select t.eq((select count(*)::int from app.assets), 5,
            'an auditor reads every asset in the company');
select t.eq((select count(*)::int from app.asset_financials), 4,
            'and every financial record that exists (the generator has none)');
select t.ok(app.can_see_financials('aaaaaaaa-0000-0000-0000-000000000001'),
            'auditors are inside the financial permission');
select t.ok(not app.can_write('aaaaaaaa-0000-0000-0000-000000000001'),
            'can_write() is false for an auditor');

-- USING excludes an auditor entirely, so the row is invisible to the write
-- and the statement is a no-op. Assert nothing moved, then prove it.
select t.affects($$
  update app.assets set holder = 'auditor was here'
   where id = 'a1000000-0000-0000-0000-00000000000a'
$$, 0, 'an auditor cannot write to the register');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-NEW-1','Something','active',
          'c0000000-0000-0000-0000-00000000000a')
$$, 'an auditor cannot add assets');

-- --- Femi: requester at Lagos ---------------------------------------------
select t.as_user('44444444-4444-4444-4444-444444444444');

select t.eq((select count(*)::int from app.assets), 4,
            'a requester sees the assets at his own site');
select t.eq((select count(*)::int from app.asset_financials), 0,
            'and none of the costs');
select t.ok(app.can_write('aaaaaaaa-0000-0000-0000-000000000001'),
            'a requester may raise things');
select t.raises($$
  insert into app.memberships (company_id, user_id, role)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          '99999999-9999-9999-9999-999999999999','admin')
$$, 'a requester cannot grant access to anyone');

-- --- Adeola: owner ---------------------------------------------------------
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.eq((select count(*)::int from app.assets), 5, 'the owner sees everything');
select t.eq((select count(*)::int from app.asset_financials), 4, 'including all costs');
select t.eq(app.role_in('aaaaaaaa-0000-0000-0000-000000000001')::text, 'owner',
            'role_in() resolves to the strongest role held');

reset role;
