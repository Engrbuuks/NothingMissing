-- ============================================================================
-- 06 — LOCATION ARCHIVING AND DOCUMENT NUMBERING
-- ============================================================================
set role authenticated;
select t.heading('Location archiving');

select t.as_user('11111111-1111-1111-1111-111111111111');

select t.raises($$
  select app.archive_location('c0000000-0000-0000-0000-0000000000ff')
$$, 'the virtual warehouse can never be archived', 'virtual warehouse');

select t.raises($$
  select app.archive_location('c0000000-0000-0000-0000-00000000000b')
$$, 'a location holding assets cannot be archived', 'still holds');

select t.eq(app.sweep_location('c0000000-0000-0000-0000-00000000000b'), 4,
            'sweeping moved all four assets to the virtual warehouse');
select t.eq((select count(*)::int from app.assets
             where location_id = 'c0000000-0000-0000-0000-0000000000ff'), 4,
            'they are in the virtual warehouse');

-- Empty, but a consignment is still open against it.
insert into app.transfers
  (id, company_id, reference, from_location, to_location, status, requested_by)
values ('33330000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','TR-0314',
        'c0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000b','approved',
        '11111111-1111-1111-1111-111111111111');

select t.raises($$
  select app.archive_location('c0000000-0000-0000-0000-00000000000b')
$$, 'an open consignment blocks archiving too', 'still open');

update app.transfers set status = 'cancelled'
 where id = '33330000-0000-0000-0000-00000000000a';

select app.archive_location('c0000000-0000-0000-0000-00000000000b');
select t.ok((select archived_at is not null from app.locations
             where id = 'c0000000-0000-0000-0000-00000000000b'),
            'once clear, the location archives');

-- The crucial part: history still resolves.
select t.eq((select name from app.locations
             where id = 'c0000000-0000-0000-0000-00000000000b'), 'Ibadan Depot',
            'the archived location still resolves by id, so old waybills read correctly');
select t.ok(exists (select 1 from app.transfers
                    where to_location = 'c0000000-0000-0000-0000-00000000000b'),
            'past transfers still point at it without dangling');

select t.raises($$
  insert into app.assets (company_id, tag, name, status, location_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','ZF-GHOST-1','Ghost','active',
          'c0000000-0000-0000-0000-00000000000b')
$$, 'nothing new can be placed in an archived location', 'archived');

select t.heading('Document numbering');

-- Gap-free and per company. A rolled-back transaction must not burn a number
-- the way a sequence would.
select app.next_doc_number('aaaaaaaa-0000-0000-0000-000000000001','po') as p1 \gset
select app.next_doc_number('aaaaaaaa-0000-0000-0000-000000000001','po') as p2 \gset
select t.ok(:'p1' like 'PO-%-0001', 'first purchase order is ' || :'p1');
select t.ok(:'p2' like 'PO-%-0002', 'second is ' || :'p2' || ' — no gap');

-- The other company numbers independently, starting from one.
select t.as_user('99999999-9999-9999-9999-999999999999');
select app.next_doc_number('bbbbbbbb-0000-0000-0000-000000000002','po') as p3 \gset
select t.ok(:'p3' like 'PO-%-0001',
            'the other company starts at ' || :'p3' || ', not continuing our sequence');

reset role;
