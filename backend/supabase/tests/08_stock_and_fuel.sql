-- ============================================================================
-- 08 — HOW A QUANTITY GOES DOWN
-- Issue, transfer, shrinkage, and the fuel burn-rate check.
-- ============================================================================
set role authenticated;
select t.heading('Stock: the ledger is the truth, the balance is a cache');

select t.as_user('11111111-1111-1111-1111-111111111111');

-- Receipt: 5,000 litres arrive at Lagos HQ.
select app.post_stock_movement(
  '50000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000a',
  'receipt', 5000, 'Delivery from Halogen Trading');
select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
                              'c0000000-0000-0000-0000-00000000000a'), 5000::numeric,
            'a receipt raises the balance');

-- Issue: 200 litres to the generator, with the meter reading at the time.
select app.issue_stock(
  '50000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000a',
  200, 'a1000000-0000-0000-0000-00000000000e', 1000, null, 'Weekly top-up');
select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
                              'c0000000-0000-0000-0000-00000000000a'), 4800::numeric,
            'issuing 200 litres reduces the balance to 4,800');

select t.eq((select qty from app.stock_movements
             where kind = 'issue' order by id desc limit 1), -200::numeric,
            'the movement is stored signed, so the sign cannot drift from a direction column');

select t.eq((select balance_after from app.stock_movements order by id desc limit 1),
            4800::numeric,
            'and each row carries the balance it produced, so the ledger reads on its own');

-- The balance is derived, and provably so.
select t.eq((select sum(qty) from app.stock_movements
             where item_id = '50000000-0000-0000-0000-00000000000a'
               and location_id = 'c0000000-0000-0000-0000-00000000000a'), 4800::numeric,
            'the ledger sums to the same figure');
select t.eq((select count(*)::int from app.verify_stock_integrity(
              'aaaaaaaa-0000-0000-0000-000000000001')), 0,
            'the integrity check finds no drift between cache and ledger');

select t.heading('Stock: what is not allowed');

select t.raises($$
  select app.issue_stock('50000000-0000-0000-0000-00000000000a',
    'c0000000-0000-0000-0000-00000000000a', 99999)
$$, 'cannot issue more than is there', 'cannot remove');

select t.raises($$
  select app.issue_stock('50000000-0000-0000-0000-00000000000b',
    'c0000000-0000-0000-0000-00000000000a', 2.5)
$$, 'cannot issue half a helmet', 'whole units');

select t.raises($$
  update app.stock_movements set qty = -1 where id = (select max(id) from app.stock_movements)
$$, 'the ledger cannot be edited after the fact');

select t.raises($$
  delete from app.stock_movements where id = (select max(id) from app.stock_movements)
$$, 'and a movement cannot be deleted');

select t.raises($$
  insert into app.stock_movements
    (company_id, item_id, location_id, kind, qty, balance_after, actor_label)
  values ('aaaaaaaa-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',
          'c0000000-0000-0000-0000-00000000000a','receipt', 99999, 99999, 'Forged')
$$, 'and nobody can write to it directly, bypassing the balance', 'permission denied');

select t.heading('Stock: moving between sites conserves the total');

select t.eq((select sum(qty) from app.stock_balances
             where item_id = '50000000-0000-0000-0000-00000000000a'), 4800::numeric,
            'total across all sites before the transfer');
select app.transfer_stock('50000000-0000-0000-0000-00000000000a',
  'c0000000-0000-0000-0000-00000000000a','c0000000-0000-0000-0000-00000000000c',
  800, 'Abuja running low');
select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
                              'c0000000-0000-0000-0000-00000000000a'), 4000::numeric,
            'Lagos went down by 800');
select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
                              'c0000000-0000-0000-0000-00000000000c'), 800::numeric,
            'Abuja went up by 800');
select t.eq((select sum(qty) from app.stock_balances
             where item_id = '50000000-0000-0000-0000-00000000000a'), 4800::numeric,
            'and the company still holds exactly 4,800 — a transfer creates nothing');

select t.heading('Shrinkage: the only way it is ever found is by counting');

-- 4,000 litres on the books at Lagos. The dipstick says 3,910.
insert into app.stock_counts (id, company_id, location_id, reference, counted_by, status)
values ('70000000-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-00000000000a','SC-0001','Musa Adeyinka','submitted');

insert into app.stock_count_lines
  (company_id, count_id, item_id, book_qty, counted_qty, accepted, note) values
  ('aaaaaaaa-0000-0000-0000-000000000001','70000000-0000-0000-0000-00000000000a',
   '50000000-0000-0000-0000-00000000000a', 4000, 3910, true, 'Seam on drum 3 was weeping');

select app.post_stock_count('70000000-0000-0000-0000-00000000000a')::text as res \gset

select t.eq(app.stock_balance('50000000-0000-0000-0000-00000000000a',
                              'c0000000-0000-0000-0000-00000000000a'), 3910::numeric,
            'posting the count corrected the balance to what was physically there');
select t.eq((select kind::text from app.stock_movements order by id desc limit 1),
            'count_adjust',
            'and it did so by writing a movement, not by overwriting a number');
select t.eq((select qty from app.stock_movements order by id desc limit 1), -90::numeric,
            'the movement is exactly the shrinkage: 90 litres');
select t.ok((select reason from app.stock_movements order by id desc limit 1)
            like '%Musa Adeyinka%',
            'with the counter''s name on it, so the loss is attributable');
select t.ok((select reason from app.stock_movements order by id desc limit 1)
            like '%weeping%',
            'and their explanation attached');

select t.raises($$
  select app.post_stock_count('70000000-0000-0000-0000-00000000000a')
$$, 'a count cannot be posted twice', 'already been posted');

select t.eq((select count(*)::int from app.verify_stock_integrity(
              'aaaaaaaa-0000-0000-0000-000000000001')), 0,
            'the ledger and the cache still agree after the correction');

select t.heading('Fuel: issued versus what the engine could have burned');

-- 8 hours on the clock at 19.8 L/hr is about 158 litres of real consumption.
-- Issue roughly that much and the reconciliation should read normal.
select app.issue_stock('50000000-0000-0000-0000-00000000000a',
  'c0000000-0000-0000-0000-00000000000a', 160,
  'a1000000-0000-0000-0000-00000000000e', 1008, null, 'Refuel after an 8 hour run');

select app.fuel_reconciliation('a1000000-0000-0000-0000-00000000000e')::jsonb as fr \gset
select t.eq(((:'fr')::jsonb ->> 'burn_rate')::numeric, 19.8::numeric,
            'burn rate came from the catalog model, not from anyone typing it');
select t.eq(((:'fr')::jsonb ->> 'meter_hours')::numeric, 8::numeric,
            'meter moved 8 hours between issues');
select t.eq(((:'fr')::jsonb ->> 'expected')::numeric, 158.4::numeric,
            'so the engine could have burned 158.4 litres');
select t.eq(((:'fr')::jsonb ->> 'flag'), 'investigate',
            '360 litres issued against 158 the engine could burn is flagged, not shrugged at');
select t.eq(((:'fr')::jsonb ->> 'unexplained')::numeric, 201.6::numeric,
            'and the gap is stated as 201.6 litres, which is a quantity someone can go and look for');

-- Now make it obviously wrong: a large draw with no meter movement at all.
select app.issue_stock('50000000-0000-0000-0000-00000000000a',
  'c0000000-0000-0000-0000-00000000000a', 900,
  'a1000000-0000-0000-0000-00000000000e', 1008, null, 'Large draw, generator did not run');

select app.fuel_reconciliation('a1000000-0000-0000-0000-00000000000e')::jsonb as fr2 \gset
select t.eq(((:'fr2')::jsonb ->> 'flag'), 'investigate',
            '900 more litres with the meter unmoved is flagged for investigation');
select t.ok(((:'fr2')::jsonb ->> 'unexplained')::numeric > 1000,
            'and the unexplained volume is stated in litres, not as a percentage alone');

-- A model with no rate must say so plainly rather than inventing a figure.
select t.eq((app.fuel_reconciliation('a1000000-0000-0000-0000-00000000000a')::jsonb ->> 'flag'),
            'no_burn_rate',
            'an asset whose model has no burn rate reports that, rather than guessing');

select t.heading('Stock respects tenancy and location scope like everything else');

select t.as_user('22222222-2222-2222-2222-222222222222');   -- Ngozi, Abuja only
select t.eq((select count(*)::int from app.stock_balances
             where location_id = 'c0000000-0000-0000-0000-00000000000a'), 0,
            'the Abuja manager cannot see Lagos stock levels');
select t.eq((select count(*)::int from app.stock_balances
             where location_id = 'c0000000-0000-0000-0000-00000000000c'), 1,
            'but sees her own');
select t.raises($$
  select app.issue_stock('50000000-0000-0000-0000-00000000000a',
    'c0000000-0000-0000-0000-00000000000a', 10)
$$, 'and cannot draw stock from a site she has no rights over', 'cannot move stock');

select t.as_user('99999999-9999-9999-9999-999999999999');   -- the other company
select t.eq((select count(*)::int from app.stock_movements), 0,
            'the rival company sees none of the ledger');
select t.eq((select count(*)::int from app.stock_items
             where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0,
            'nor any of the items');
select t.raises($$
  select app.issue_stock('50000000-0000-0000-0000-00000000000a',
    'c0000000-0000-0000-0000-00000000000a', 10)
$$, 'and cannot issue from another company''s store');

reset role;
