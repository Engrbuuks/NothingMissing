-- ============================================================================
-- 14. PARKED IMPORT SHEETS
--
-- The preview step used to redirect with the whole spreadsheet in the query
-- string. Percent encoding makes a 4 KB file a 5.7 KB URL, so a 16 KB header
-- cap arrives at around 170 rows, and an over long redirect reports nothing.
-- The page simply does not change, which is the same symptom as the import
-- timeout and just as hard to diagnose from the outside.
--
-- Now the sheet is parked and the URL carries an id. That moves a pasted file
-- out of the address bar and into a table, which is a privacy question as much
-- as a length one: a half checked import is not yet the company's business, so
-- it stays with the person who pasted it.
-- ============================================================================
set role authenticated;
select t.heading('Parked import sheets');

select t.as_user('11111111-1111-1111-1111-111111111111');
select t.assert_actor_persists('11111111-1111-1111-1111-111111111111');

reset role;
create or replace function t.park_a_sheet() returns uuid
language sql as $$
  select app.park_import_draft(
    'aaaaaaaa-0000-0000-0000-000000000001', 'assets',
    E'Name,Units\nTask chair,40\nMeeting table,6',
    'Osun Office', null, 'Osogbo');
$$;

-- Somewhere to keep the id between statements. Each psql statement is its own
-- transaction, so a temporary table would not outlive the line that made it.
create table if not exists t.parked (id uuid);
grant select, insert, delete, truncate on t.parked to authenticated;
set role authenticated;

-- ── a sheet goes in and comes back unchanged ────────────────────────────────
truncate t.parked;
insert into t.parked select t.park_a_sheet();

select t.eq((select count(*)::int from t.parked where id is not null), 1,
            'parking a sheet returns an id to put in the URL');

select t.eq((select sheet from app.read_import_draft((select id from t.parked))),
            E'Name,Units\nTask chair,40\nMeeting table,6',
            'and the sheet reads back byte for byte');

select t.eq((select branch from app.read_import_draft((select id from t.parked))),
            'Osun Office',
            'along with the branch it was headed for');

select t.eq((select city from app.read_import_draft((select id from t.parked))),
            'Osogbo', 'and the city, so a new location is still created properly');

-- ── a file far too big for a URL is no trouble at all ──────────────────────
-- Twelve thousand rows, which as a query string would be about 1.4 MB.
reset role;
create or replace function t.park_a_big_sheet() returns int
language plpgsql as $$
declare v_sheet text; v_id uuid;
begin
  select 'Name,Units' || string_agg(E'\nItem ' || g || ',10', '')
    into v_sheet from generate_series(1, 12000) g;
  v_id := app.park_import_draft('aaaaaaaa-0000-0000-0000-000000000001',
            'assets', v_sheet, 'Osun Office');
  return length((select sheet from app.read_import_draft(v_id)));
end $$;
set role authenticated;

select t.ok(t.park_a_big_sheet() > 150000,
            'a 12,000 row sheet survives the round trip, where a URL could not');

-- ── a colleague cannot read it ─────────────────────────────────────────────
-- Adeola is a company-wide admin at the same company, so this is not a
-- tenancy test: it is the narrower claim that an unfinished import belongs to
-- the person doing it.
select t.as_user('22222222-2222-2222-2222-222222222222');
select t.eq((select count(*)::int from app.read_import_draft((select id from t.parked))), 0,
            'an admin at the same company cannot read a sheet somebody else pasted');

-- ── and neither can a rival ────────────────────────────────────────────────
select t.as_user('99999999-9999-9999-9999-999999999999');
select t.eq((select count(*)::int from app.read_import_draft((select id from t.parked))), 0,
            'nor can anybody outside the company');

select t.raises($$select app.park_import_draft(
                    'aaaaaaaa-0000-0000-0000-000000000001', 'assets', 'Name\nChair')$$,
               'nor can a rival park a sheet against it',
               'not permitted');

-- ── a draft cannot be edited after it has been previewed ───────────────────
-- If it could, the sheet checked on the review page and the sheet committed
-- could differ, which is the one thing a two step import exists to prevent.
select t.as_user('11111111-1111-1111-1111-111111111111');
select t.eq((select count(*)::int from pg_policies
              where schemaname = 'app' and tablename = 'import_drafts'
                and cmd = 'UPDATE'), 0,
            'there is no way to change a parked sheet in place');

-- ── the person who pasted it can throw it away ─────────────────────────────
-- The delete is its own statement: a data-modifying CTE cannot sit inside a
-- function argument.
delete from app.import_drafts where id = (select id from t.parked);

select t.eq((select count(*)::int from app.read_import_draft((select id from t.parked))), 0,
            'and can discard their own');

-- ── stale drafts do not pile up ────────────────────────────────────────────
reset role;
create or replace function t.stale_is_swept() returns int
language plpgsql as $$
declare v_old uuid; v_left int;
begin
  insert into app.import_drafts (company_id, user_id, kind, sheet, created_at)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111', 'assets', 'Name\nOld',
          now() - interval '2 days')
  returning id into v_old;

  -- Parking the next one sweeps, so nothing needs scheduling.
  perform app.park_import_draft('aaaaaaaa-0000-0000-0000-000000000001',
            'assets', E'Name\nFresh');

  select count(*)::int into v_left from app.import_drafts where id = v_old;
  return v_left;
end $$;
set role authenticated;

select t.eq(t.stale_is_swept(), 0,
            'a sheet left unconfirmed for days is cleared by the next import');

-- ── an unknown kind is refused ─────────────────────────────────────────────
select t.raises($$select app.park_import_draft(
                    'aaaaaaaa-0000-0000-0000-000000000001', 'vehicles', 'Name\nX')$$,
               'only assets and inventory can be imported',
               'unknown import kind');

select t.raises($$select app.park_import_draft(
                    'aaaaaaaa-0000-0000-0000-000000000001', 'assets', '   ')$$,
               'and an empty paste is caught before a draft is made',
               'nothing to preview');
