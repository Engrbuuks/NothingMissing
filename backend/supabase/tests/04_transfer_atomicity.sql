-- ============================================================================
-- 04 — THE TRANSFER LIFECYCLE
-- Dispatch, in-transit limbo, partial receipt, and the atomicity guarantee.
-- ============================================================================
set role authenticated;
select t.heading('Transfer lifecycle');

select t.as_user('11111111-1111-1111-1111-111111111111');

-- --- dispatch --------------------------------------------------------------
select t.eq((select waybill_no from app.transfers
             where id = '11110000-0000-0000-0000-00000000000a'), null::text,
            'no waybill exists before dispatch');

select app.dispatch_transfer('11110000-0000-0000-0000-00000000000a') as wb \gset

select t.ok(:'wb' like 'WB-%-0001', 'dispatch issued the first waybill of the year: ' || :'wb');
select t.eq((select status::text from app.transfers
             where id = '11110000-0000-0000-0000-00000000000a'), 'in_transit',
            'the transfer is now in transit');

-- In-transit is a real state: the assets belong to neither register.
select t.eq((select count(*)::int from app.assets
             where status = 'transit' and location_id is null
               and company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 3,
            'all three assets are in transit with no location');
-- Be specific: other assets legitimately remain at Lagos. What matters is
-- that these three are no longer on its register.
select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000a'
               and id in ('a1000000-0000-0000-0000-00000000000a',
                          'a1000000-0000-0000-0000-00000000000b',
                          'a1000000-0000-0000-0000-00000000000c')), 0,
            'the three consigned assets have left the Lagos register');
select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000c'), 1,
            'and have not arrived at Abuja yet');

select t.raises($$
  select app.dispatch_transfer('11110000-0000-0000-0000-00000000000a')
$$, 'a consignment cannot be dispatched twice');

-- --- only the destination may accept ---------------------------------------
select t.as_user('44444444-4444-4444-4444-444444444444');   -- Femi, Lagos
select t.raises($$
  select app.accept_transfer('11110000-0000-0000-0000-00000000000a')
$$, 'someone at the origin cannot accept the delivery', 'destination');

-- --- partial receipt: two arrive, one does not -----------------------------
select t.as_user('22222222-2222-2222-2222-222222222222');   -- Ngozi, Abuja

select app.accept_transfer(
  '11110000-0000-0000-0000-00000000000a',
  array['a1000000-0000-0000-0000-00000000000c']::uuid[],
  'One box short — driver says only two were loaded'
)::text as res \gset

select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000c'), 3,
            'the two confirmed assets landed on the Abuja register');
select t.eq((select status::text from app.assets
             where id = 'a1000000-0000-0000-0000-00000000000c'), 'transit',
            'the flagged asset stays in transit, not silently received');
select t.eq((select count(*)::int from app.discrepancies where resolved_at is null), 1,
            'a discrepancy was opened for it');
select t.eq((select status::text from app.transfers
             where id = '11110000-0000-0000-0000-00000000000a'), 'in_transit',
            'the waybill does not close while anything is outstanding');

select t.raises($$
  select app.accept_transfer('11110000-0000-0000-0000-00000000000a')
$$, 'a partially received consignment cannot be accepted again');

-- --- resolving the discrepancy closes the waybill --------------------------
select id as disc from app.discrepancies where resolved_at is null limit 1 \gset
select app.resolve_discrepancy(:'disc'::uuid, 'found', 'Turned up on the next run');

select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000c'), 4,
            'the late asset joined the destination register');
select t.eq((select status::text from app.transfers
             where id = '11110000-0000-0000-0000-00000000000a'), 'received',
            'and the waybill closed once nothing was outstanding');
select t.eq((select count(*)::int from app.discrepancies where resolved_at is null), 0,
            'no discrepancies left open');

-- --- the audit trail wrote itself ------------------------------------------
select t.ok((select count(*) from app.audit_events
             where reference = :'wb') >= 2,
            'dispatch and receipt both left audit rows against the waybill');
select t.ok(exists (select 1 from app.audit_events
                    where action = 'accepted delivery' and reference = :'wb'),
            'the acceptance is recorded by name');
select t.ok(exists (select 1 from app.audit_events
                    where action = 'flagged a delivery line'),
            'so is the flagged line');
select t.eq((select actor_label from app.audit_events
             where action = 'accepted delivery' and reference = :'wb' limit 1),
            'Ngozi Okafor',
            'and it names the person who actually pressed the button');

reset role;
