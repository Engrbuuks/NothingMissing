-- ============================================================================
-- 11 — PROCUREMENT, MAINTENANCE AND DISPOSAL
-- ============================================================================
set role authenticated;
select t.heading('Goods receipt refuses to invent assets');

select t.as_user('11111111-1111-1111-1111-111111111111');

insert into app.suppliers (id, company_id, name, email, supplies)
values ('90000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
        'Halogen Trading Ltd','sales@halogen.test','IT equipment and furniture')
on conflict do nothing;

insert into app.purchase_orders
  (id, company_id, reference, supplier_id, destination, status, issued_at, raised_by)
values ('91000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
        'PO-TEST-0001','90000000-0000-0000-0000-00000000000a',
        'c0000000-0000-0000-0000-00000000000a','issued', now() - interval '9 days',
        '11111111-1111-1111-1111-111111111111');

insert into app.purchase_order_lines
  (company_id, po_id, line_no, kind, description, qty, unit_cost_minor, model_id, stock_item_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001','91000000-0000-0000-0000-00000000000a',1,
   'asset','Dell OptiPlex 7410 AIO',3,148000000,'e3000000-0000-0000-0000-00000000000a',null),
  ('aaaaaaaa-0000-0000-0000-000000000001','91000000-0000-0000-0000-00000000000a',2,
   'stock','Diesel top-up',500,125000,null,'50000000-0000-0000-0000-00000000000a'),
  ('aaaaaaaa-0000-0000-0000-000000000001','91000000-0000-0000-0000-00000000000a',3,
   'service','Delivery and installation',1,12000000,null,null);

-- Three machines arriving, two serials offered. This is the exact moment a
-- register starts lying, so it is refused.
select t.raises($$
  select app.receive_goods('91000000-0000-0000-0000-00000000000a',
    '[{"line_no":1,"serials":["SN-A1","SN-A2"]}]'::jsonb)
$$, 'three units with two serials is refused', '2 serial(s) supplied');

select t.eq((select count(*)::int from app.assets where tag like 'AC-%'), 0,
            'and nothing was created by the attempt');

select app.receive_goods('91000000-0000-0000-0000-00000000000a',
  '[{"line_no":1,"serials":["SN-A1","SN-A2","SN-A3"]}]'::jsonb)::text as rg \gset

select t.eq(((:'rg')::jsonb ->> 'assets_created')::int, 3,
            'with all three serials, three assets are created');
select t.eq((select count(*)::int from app.assets
             where serial_no in ('SN-A1','SN-A2','SN-A3')), 3,
            'each carrying its own serial, so each can be scan-matched later');
select t.eq((select count(distinct tag)::int from app.assets where tag like 'AC-%'), 3,
            'with three distinct tags');
select t.eq((select count(*)::int from app.asset_financials f
             join app.assets a on a.id = f.asset_id where a.tag like 'AC-%'), 3,
            'and a financial record each, filed against the purchase order');
select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
              'c0000000-0000-0000-0000-00000000000a'), 4350::numeric,
            'the stock line was received into the ledger too (3850 + 500)');

select t.eq((app.supplier_lead_time('90000000-0000-0000-0000-00000000000a')::jsonb ->> 'orders')::int, 1,
            'lead time is now computed from a real order');
select t.ok((app.supplier_lead_time('90000000-0000-0000-0000-00000000000a')::jsonb ->> 'avg_days')::numeric >= 8,
            'and reads about nine days, from timestamps rather than a promise');

select t.raises($$
  select app.receive_goods('91000000-0000-0000-0000-00000000000a')
$$, 'a received order cannot be received again', 'nothing can be received');

select t.heading('Maintenance is scheduled from the catalog, not per asset');

-- ZF-GEN-0041 is at 1008 hours on a 250-hour interval.
select t.eq((select state from app.maintenance_due('aaaaaaaa-0000-0000-0000-000000000001')
             where tag = 'ZF-GEN-0041'), 'overdue',
            'the generator reads overdue against its model interval');

select app.log_service('a1000000-0000-0000-0000-00000000000e','250-hour service',
                       18000000,'Sahara Power','Filters and oil');

select t.eq((select state from app.maintenance_due('aaaaaaaa-0000-0000-0000-000000000001')
             where tag = 'ZF-GEN-0041'), 'ok',
            'logging the service resets it, because the meter is measured from the last event');
select t.eq((select count(*)::int from app.maintenance_events
             where asset_id = 'a1000000-0000-0000-0000-00000000000e'), 1,
            'and the service is on the asset''s history');

select t.heading('Return to service closes a repair');

update app.assets set status = 'repair' where id = 'a1000000-0000-0000-0000-00000000000b';
select app.return_to_service('a1000000-0000-0000-0000-00000000000b','Repaired and working',
                             45000000,'Gearbox rebuilt');
select t.eq((select status::text from app.assets where id = 'a1000000-0000-0000-0000-00000000000b'),
            'active', 'the asset is back in service');

select t.raises($$
  select app.return_to_service('a1000000-0000-0000-0000-00000000000b','Repaired and working')
$$, 'an asset not out for repair cannot be returned', 'not out for repair');

-- A failed repair does not silently retire the asset.
update app.assets set status = 'repair' where id = 'a1000000-0000-0000-0000-00000000000c';
select app.return_to_service('a1000000-0000-0000-0000-00000000000c',
                             'Could not be repaired', null, 'Beyond economic repair');
select t.eq((select status::text from app.assets where id = 'a1000000-0000-0000-0000-00000000000c'),
            'repair',
            'a failed repair leaves it out of service — it must go through disposal, not vanish');

select t.heading('Disposal demands evidence');

select t.raises($$
  select app.dispose_asset('a1000000-0000-0000-0000-00000000000c','stolen')
$$, 'a theft with no police reference is refused', 'needs a reference');

select t.raises($$
  select app.dispose_asset('a1000000-0000-0000-0000-00000000000c','sold')
$$, 'a sale with no proceeds recorded is refused', 'record the proceeds');

select app.dispose_asset('a1000000-0000-0000-0000-00000000000c','sold', 30000000,
                         null, 'Sold to a staff member')::text as dp \gset

select t.eq((select status::text from app.assets where id = 'a1000000-0000-0000-0000-00000000000c'),
            'retired', 'a proper disposal retires the asset');
select t.ok(((:'dp')::jsonb ->> 'reference') like 'DSP-%',
            'and issues a certificate reference: ' || ((:'dp')::jsonb ->> 'reference'));
select t.ok(((:'dp')::jsonb ->> 'loss_minor')::bigint > 0,
            'selling below book value is reported as a loss on disposal');
select t.eq((select count(*)::int from app.assets
             where id = 'a1000000-0000-0000-0000-00000000000c'
               and location_id = (select id from app.locations
                                  where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                                    and kind = 'virtual')), 1,
            'and it moves to the virtual warehouse rather than leaving a dangling location');

select t.raises($$
  select app.dispose_asset('a1000000-0000-0000-0000-00000000000c','scrapped',null,'SCR-1')
$$, 'an asset cannot be disposed of twice', 'already been disposed');

select t.raises($$
  insert into app.disposals (company_id, reference, asset_id, reason)
  values ('aaaaaaaa-0000-0000-0000-000000000001','DSP-FORGED',
          'a1000000-0000-0000-0000-00000000000b','lost')
$$, 'and nobody can write a disposal directly, bypassing the evidence rules',
    'permission denied');

select t.heading('Procurement respects roles and tenancy');

select t.as_user('22222222-2222-2222-2222-222222222222');   -- manager, no financials
select t.eq((select count(*)::int from app.purchase_orders), 0,
            'a location manager sees no purchase orders — they carry prices');
-- Three events by now: the logged service plus the two return-to-service
-- records. All operational, so all visible.
select t.eq((select count(*)::int from app.maintenance_events), 3,
            'but does see maintenance history, which is operational not financial');
select t.raises($$
  select app.dispose_asset('a1000000-0000-0000-0000-00000000000d','scrapped',null,'SCR-9')
$$, 'and cannot dispose of anything', 'only an owner or admin');

select t.as_user('99999999-9999-9999-9999-999999999999');
select t.eq((select count(*)::int from app.suppliers), 0,
            'another company sees none of the suppliers');
select t.eq((select count(*)::int from app.maintenance_due(
              'aaaaaaaa-0000-0000-0000-000000000001')), 0,
            'nor what is due for service');
select t.raises($$
  select app.receive_goods('91000000-0000-0000-0000-00000000000a')
$$, 'and cannot receive against their order');

reset role;
