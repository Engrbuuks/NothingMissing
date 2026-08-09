-- ============================================================================
-- 01 — TENANT ISOLATION
-- The test that matters more than any other. Written before the tenth table
-- existed, not after. Runs as Kola, who owns a completely unrelated company,
-- and asserts he can reach nothing belonging to Zenith Facilities.
-- ============================================================================
set role authenticated;
select t.heading('Tenant isolation — Kola (Rival Logistics) versus Zenith Facilities');

select t.as_user('99999999-9999-9999-9999-999999999999');
select t.assert_actor_persists('99999999-9999-9999-9999-999999999999');

select t.eq((select count(*)::int from app.companies
             where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see the other company row');

select t.eq((select count(*)::int from app.locations
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their locations');

select t.eq((select count(*)::int from app.assets
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their assets');

select t.eq((select count(*)::int from app.asset_financials
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their financial records');

select t.eq((select count(*)::int from app.models
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their catalog models');

select t.eq((select count(*)::int from app.transfers
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their transfers');

select t.eq((select count(*)::int from app.audit_events
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see any of their audit history');

select t.eq((select count(*)::int from app.memberships
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'cannot see who works there');

select t.eq((select count(*)::int from app.profiles
             where id = '11111111-1111-1111-1111-111111111111'), 0,
            'cannot see the profile of someone in another company');

-- An unfiltered read must return only his own rows, never a mixture.
select t.eq((select count(*)::int from app.assets), 1,
            'an unfiltered asset query returns only his own row');
select t.eq((select count(distinct company_id)::int from app.assets), 1,
            'no query can straddle two companies');

-- Writes are barred as firmly as reads, but note the shape of the barrier:
-- RLS makes the row invisible, so the UPDATE is a no-op rather than an error.
-- Asserting "it raised" would be asserting the wrong thing; assert that
-- nothing moved.
select t.affects($$
  update app.assets set holder = 'stolen by me'
  where id = 'a1000000-0000-0000-0000-00000000000a'
$$, 0, 'an update aimed at another company touches nothing');

select t.affects($$
  delete from app.assets where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
$$, 0, 'a delete aimed at another company removes nothing');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','RV-HACK-1','Trojan','active',
          'c0000000-0000-0000-0000-00000000000a')
$$, 'cannot insert into another company');

select t.raises($$
  insert into app.memberships (company_id, user_id, role)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          '99999999-9999-9999-9999-999999999999','owner')
$$, 'cannot grant himself membership of another company');

-- An update that would move his own row into the other tenant must fail on
-- WITH CHECK even though USING allows him to touch the row at all.
select t.raises($$
  update app.assets
     set company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
   where id = 'b1000000-0000-0000-0000-00000000000a'
$$, 'cannot reassign his own asset into another company');

-- The RPCs must refuse him too, not just the tables.
select t.raises($$
  select app.accept_transfer('11110000-0000-0000-0000-00000000000a')
$$, 'cannot accept another company''s delivery');

select t.raises($$
  select app.archive_location('c0000000-0000-0000-0000-00000000000b')
$$, 'cannot archive another company''s location');

select t.raises($$
  select app.sweep_location('c0000000-0000-0000-0000-00000000000a')
$$, 'cannot sweep another company''s location');

-- Confirm from the other side that the attempted write really did nothing.
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.eq((select holder from app.assets where id = 'a1000000-0000-0000-0000-00000000000a'),
            'Finance desk 3',
            'the targeted asset is provably unchanged when read by its real owner');
select t.eq((select count(*)::int from app.assets
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 5,
            'and none of their assets were deleted');

reset role;
