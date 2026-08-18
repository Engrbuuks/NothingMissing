-- ============================================================================
-- 05 — ALL OR NOTHING
-- The claim the product makes is that a failed acceptance moves nothing.
-- Prove it by forcing a failure part-way through and checking the register.
-- ============================================================================
set role authenticated;
select t.heading('Atomicity — a failure part-way through must move nothing');

select t.as_user('11111111-1111-1111-1111-111111111111');

-- A fresh consignment: Abuja -> Ibadan, four assets.
insert into app.transfers
  (id, company_id, reference, from_location, to_location, status, requested_by)
values
  ('22220000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','TR-0313',
   'c0000000-0000-0000-0000-00000000000c','c0000000-0000-0000-0000-00000000000b','approved',
   '11111111-1111-1111-1111-111111111111');

insert into app.transfer_lines (company_id, transfer_id, asset_id)
select 'aaaaaaaa-0000-0000-0000-000000000001','22220000-0000-0000-0000-00000000000a', id
from app.assets where location_id = 'c0000000-0000-0000-0000-00000000000c';

select app.dispatch_transfer('22220000-0000-0000-0000-00000000000a') as wb2 \gset
select t.eq((select count(*)::int from app.assets where status = 'transit'), 4,
            'four assets are in transit on ' || :'wb2');

-- Break the destination mid-flight, so the UPDATE inside accept_transfer
-- fails on the archived-location guard after some rows have already moved.
update app.locations set archived_at = now()
 where id = 'c0000000-0000-0000-0000-00000000000b';

select t.raises($$
  select app.accept_transfer('22220000-0000-0000-0000-00000000000a')
$$, 'the acceptance failed as expected', 'archived');

-- The whole point: nothing partial survived.
select t.eq((select count(*)::int from app.assets where status = 'transit'), 4,
            'all four assets are still in transit — none moved');
select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000b'), 0,
            'nothing landed at the destination');
select t.eq((select status::text from app.transfers
             where id = '22220000-0000-0000-0000-00000000000a'), 'in_transit',
            'the transfer is untouched');
select t.eq((select count(*)::int from app.transfer_lines
             where transfer_id = '22220000-0000-0000-0000-00000000000a'
               and received is not null), 0,
            'no line was marked received');
select t.eq((select count(*)::int from app.audit_events
             where action = 'accepted delivery' and reference = :'wb2'), 0,
            'and no audit row claims it succeeded');

-- Put it back and let it complete properly.
update app.locations set archived_at = null
 where id = 'c0000000-0000-0000-0000-00000000000b';
select app.accept_transfer('22220000-0000-0000-0000-00000000000a');
select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-00000000000b'), 4,
            'once the obstacle is gone the same call moves all four');

reset role;
