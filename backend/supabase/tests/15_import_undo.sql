-- ============================================================================
-- 15. UNDOING AN IMPORT
--
-- The register ended up holding several identical copies of one spreadsheet,
-- and the reason is worth stating precisely, because the first account of it
-- was wrong in a way that mattered.
--
-- The tag generator made the import quadratic, so a real file ran past the
-- gateway timeout. What is killed at that point is the request, not the
-- transaction. Postgres carried on, finished the loop, and committed. The
-- browser got nothing, so the button looked dead, so it was pressed again.
--
-- Which means the recovery question is not "what failed" but "which of these
-- four identical runs do I keep". Nothing recorded which assets an import
-- created, and it turns out nothing needed to: now() is the transaction
-- timestamp, so every asset from one import shares a created_at, and the audit
-- row written at the end of the same transaction shares it too. That identity
-- is the whole mechanism, so it is the first thing asserted here.
-- ============================================================================
set role authenticated;
select t.heading('Undoing an import');

select t.as_user('11111111-1111-1111-1111-111111111111');
select t.assert_actor_persists('11111111-1111-1111-1111-111111111111');

-- A location of its own per execution. repeat_of matches runs at the same
-- place, so without this the file could not be run twice against one database:
-- the second execution's imports would be reported as repeats of the first
-- execution's, which is true but not what is being asserted.
select set_config('t.undo_site',
                  'Undo Test Site ' || to_char(clock_timestamp(), 'HH24MISSMS'), false);

reset role;
create or replace function t.a_file(p_n int default 4) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object(
           'name', 'Imported item ' || g, 'units', 2,
           'category', 'IT equipment', 'type', 'Desktop computer'))
    from generate_series(1, p_n) g;
$$;

create table if not exists t.imp (label text primary key, run_id bigint);
grant select, insert, update, delete on t.imp to authenticated;
set role authenticated;

-- ── the mechanism the whole thing rests on ─────────────────────────────────
reset role;
create or replace function t.run_and_audit_agree() returns boolean
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_id bigint; v_when timestamptz; v_distinct int;
begin
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  perform app.import_branch('aaaaaaaa-0000-0000-0000-000000000001',
            current_setting('t.undo_site'), t.a_file(), true);

  select id, occurred_at into v_id, v_when
    from app.audit_events
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and action = 'imported assets'
   order by id desc limit 1;

  insert into t.imp values ('first', v_id)
  on conflict (label) do update set run_id = excluded.run_id;

  -- Every asset the run created carries exactly the audit row's timestamp.
  select count(distinct created_at) into v_distinct
    from app.assets
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and created_at = v_when;

  return v_distinct = 1
     and (select count(*) from app.assets
           where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
             and created_at = v_when) = 8;
end $$;
set role authenticated;

select t.ok(t.run_and_audit_agree(),
            'an import stamps every asset with the timestamp of its own audit row');

-- ── the same file twice is named as a repeat ───────────────────────────────
reset role;
create or replace function t.import_again(p_label text) returns bigint
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_id bigint;
begin
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  perform app.import_branch('aaaaaaaa-0000-0000-0000-000000000001',
            current_setting('t.undo_site'), t.a_file(), true);
  select id into v_id from app.audit_events
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and action = 'imported assets'
   order by id desc limit 1;
  insert into t.imp values (p_label, v_id)
  on conflict (label) do update set run_id = excluded.run_id;
  return v_id;
end $$;
set role authenticated;

select t.import_again('second');
select t.import_again('third');

select t.eq((select repeat_of from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'second')),
            (select run_id from t.imp where label = 'first'),
            'the second import points back at the first as its original');

select t.eq((select repeat_of from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'third')),
            (select run_id from t.imp where label = 'first'),
            'and so does the third, not at the second');

select t.ok((select repeat_of is null from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'first')),
            'the first import is never a repeat of anything, so one copy always survives');

-- ── a different file at the same place is not a repeat ─────────────────────
reset role;
create or replace function t.import_other() returns bigint
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_id bigint;
begin
  perform set_config('request.jwt.claim.sub',
                     '11111111-1111-1111-1111-111111111111', false);
  perform app.import_branch('aaaaaaaa-0000-0000-0000-000000000001',
            current_setting('t.undo_site'),
            jsonb_build_array(jsonb_build_object('name', 'Something else entirely',
              'units', 1, 'category', 'Furniture')), true);
  select id into v_id from app.audit_events
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and action = 'imported assets' order by id desc limit 1;
  insert into t.imp values ('other', v_id)
  on conflict (label) do update set run_id = excluded.run_id;
  return v_id;
end $$;
set role authenticated;

select t.import_other();
select t.ok((select repeat_of is null from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'other')),
            'a different file at the same place is left alone');

-- ── an asset that has been used is kept ────────────────────────────────────
-- Both routes: an edit through the form, and a reference from another table.
reset role;
create or replace function t.put_two_to_use() returns int
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_when timestamptz; v_a uuid; v_b uuid;
begin
  select occurred_at into v_when from app.audit_events
   where id = (select run_id from t.imp where label = 'third');

  select id into v_a from app.assets
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and created_at = v_when order by tag limit 1;
  select id into v_b from app.assets
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
     and created_at = v_when and id <> v_a order by tag limit 1;

  -- Somebody corrects who holds it.
  update app.assets set holder = 'Gabriel' where id = v_a;

  -- Somebody logs a service against the other.
  insert into app.maintenance_events (company_id, asset_id, kind, note)
  values ('aaaaaaaa-0000-0000-0000-000000000001', v_b, 'service', 'Oil change');

  return 2;
end $$;
set role authenticated;

select t.put_two_to_use();

select t.eq((select in_use from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'third')), 2,
            'an edited asset and a serviced one both count as in use');

select t.eq((select removable from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'third')), 6,
            'leaving six of the eight removable');

-- ── a stale page is refused rather than guessed at ─────────────────────────
select t.raises(
  format($$select app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001', %s, 8)$$,
         (select run_id from t.imp where label = 'third')),
  'a count from before the register moved is refused',
  'has changed since');

-- ── the undo removes its own run and nothing else ──────────────────────────
reset role;
create or replace function t.register_size() returns int
language sql security definer set search_path = app, public, pg_temp as $$
  select count(*)::int from app.assets
   where company_id = 'aaaaaaaa-0000-0000-0000-000000000001';
$$;
set role authenticated;

reset role;
create table if not exists t.sizes (label text primary key, n int);
grant select, insert, update on t.sizes to authenticated;
set role authenticated;
insert into t.sizes values ('before', t.register_size())
on conflict (label) do update set n = excluded.n;

select t.eq((select (app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001',
                      (select run_id from t.imp where label = 'third'), 6) ->> 'removed')::int), 6,
            'the undo removes exactly what it offered');

select t.eq(t.register_size(), (select n from t.sizes where label = 'before') - 6,
            'and the register shrinks by exactly that, so no other run was touched');

select t.eq((select still_present from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'first')), 8,
            'the original import is untouched');

select t.eq((select still_present from app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')
              where run_id = (select run_id from t.imp where label = 'third')), 2,
            'and the two in use assets stay on the register');

-- ── running it twice is harmless ───────────────────────────────────────────
select t.eq((select (app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001',
                      (select run_id from t.imp where label = 'third')) ->> 'removed')::int), 0,
            'undoing the same import again removes nothing');

-- ── who may do it ──────────────────────────────────────────────────────────
-- Retiring an asset is a manager's job, because it leaves a record of a thing
-- that existed. This erases rows, so it sits with whoever answers for the
-- register.
select t.as_user('22222222-2222-2222-2222-222222222222');
select t.raises(
  format($$select app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001', %s)$$,
         (select run_id from t.imp where label = 'second')),
  'a manager cannot undo an import', 'owner or admin');

select t.as_user('33333333-3333-3333-3333-333333333333');
select t.raises(
  format($$select app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001', %s)$$,
         (select run_id from t.imp where label = 'second')),
  'nor can an auditor', 'owner or admin');

-- ── and nobody outside the company sees any of it ──────────────────────────
select t.as_user('99999999-9999-9999-9999-999999999999');
select t.eq((select count(*)::int from
               app.asset_import_runs('aaaaaaaa-0000-0000-0000-000000000001')), 0,
            'a rival sees no import history at all');

select t.raises(
  format($$select app.undo_asset_import('aaaaaaaa-0000-0000-0000-000000000001', %s)$$,
         (select run_id from t.imp where label = 'second')),
  'and cannot undo an import at a company they are not in', 'owner or admin');

-- ── the two in use tests must agree with each other ────────────────────────
-- asset_is_untouched() decides what the delete removes. asset_import_runs()
-- decides what the page offers, and does the same test set at a time because
-- the per row version costs too much on a page load. Two statements of one
-- rule drift: add a table that can reference an asset, remember one, forget
-- the other, and the page offers to remove something the delete then refuses,
-- or worse, the page hides nothing and the delete takes a photograph with it.
select t.as_user('11111111-1111-1111-1111-111111111111');

select t.eq(
  (select count(*)::int from (
     select unnest(array['transfer_lines','maintenance_events','disposals','attachments',
                         'asset_attributes','discrepancies','requests','submissions',
                         'stock_movements']) as tbl
   ) want
   where position('app.' || want.tbl in
     (select pg_get_functiondef('app.asset_is_untouched(uuid)'::regprocedure))) = 0
      or position('app.' || want.tbl in
     (select pg_get_functiondef('app.asset_import_runs(uuid)'::regprocedure))) = 0),
  0,
  'both in use tests name every table that can reference an asset');

-- And the list above is itself complete: anything with a foreign key to an
-- asset must appear in it, so a table added later cannot be forgotten here.
select t.eq(
  (select count(*)::int from pg_constraint c
    where c.confrelid = 'app.assets'::regclass and c.contype = 'f'
      and c.conrelid::regclass::text <> 'app.asset_financials'
      and not (c.conrelid::regclass::text = any (array[
        'app.transfer_lines','app.maintenance_events','app.disposals','app.attachments',
        'app.asset_attributes','app.discrepancies','app.requests','app.submissions',
        'app.stock_movements']))),
  0,
  'and that list covers every foreign key pointing at an asset');
