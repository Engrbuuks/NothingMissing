-- ============================================================================
-- 13. ASSET TAG NUMBERING
--
-- The tag generator has been wrong three times, each time in a way that only
-- showed up on a real register:
--
--   count(*) + i   double counted inside the loop and reissued the numbers of
--                  deleted assets, so a printed label could come to name a
--                  different object.
--   max(...)       correct, but a regular expression scan of the whole company
--                  per asset created. An import of 1,600 units took 4.4 s on an
--                  empty register and 19.3 s on a full one. Hosting kills a
--                  function at ten to fifteen seconds, so the import did not
--                  fail. It stopped, wrote nothing, and showed no error.
--   the counter    seeded with `insert ... select max(...) on conflict do
--                  nothing`, which pays for the scan on every call because the
--                  conflict is only noticed afterwards. The counter advanced
--                  correctly and the import stayed exactly as slow, which is
--                  the worst kind of fix: one that reads as though it worked.
--
-- So the properties are asserted here rather than trusted: numbers are unique,
-- they only ever go up, an existing register is continued rather than
-- restarted, and issuing a tag does not get slower as the register grows.
-- ============================================================================
set role authenticated;
select t.heading('Asset tag numbering');

select t.as_user('11111111-1111-1111-1111-111111111111');
select t.assert_actor_persists('11111111-1111-1111-1111-111111111111');

-- ── the prefix is the company's own ─────────────────────────────────────────
select t.eq(app.next_asset_tag('aaaaaaaa-0000-0000-0000-000000000001') ~ '^ZEN-\d{5}$',
            true, 'a tag carries the company initials, not ours');

-- ── consecutive calls never repeat ──────────────────────────────────────────
select t.eq((select count(distinct tag)::int
               from (select app.next_asset_tag('aaaaaaaa-0000-0000-0000-000000000001') as tag
                       from generate_series(1, 50)) s), 50,
            'fifty calls produce fifty different tags');

-- ── a deleted number is retired, not reissued ───────────────────────────────
-- This is the failure the count(*) version shipped with. A number that has
-- been printed on a label must never come round again.
reset role;
create or replace function t.tag_after_delete() returns text
language plpgsql as $$
declare v_tag text; v_id uuid; v_next text;
begin
  v_tag := app.next_asset_tag('aaaaaaaa-0000-0000-0000-000000000001');
  insert into app.assets (company_id, tag, name, location_id, status)
  values ('aaaaaaaa-0000-0000-0000-000000000001', v_tag, 'Briefly existed',
          'c0000000-0000-0000-0000-00000000000a', 'active')
  returning id into v_id;
  delete from app.assets where id = v_id;
  v_next := app.next_asset_tag('aaaaaaaa-0000-0000-0000-000000000001');
  return case when v_next = v_tag then 'reissued ' || v_tag else 'moved on' end;
end $$;
set role authenticated;

select t.eq(t.tag_after_delete(), 'moved on',
            'the number of a deleted asset is not handed to the next one');

-- ── an existing register is continued, not restarted ────────────────────────
-- The counter did not exist before this migration, so every live company
-- meets it for the first time with a register already numbered. Seeding from
-- one is the whole reason the expensive scan is still in the function.
reset role;
create or replace function t.seed_from_existing() returns text
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_co uuid; v_tag text;
begin
  -- A fresh company each run rather than cleaning up the last one: a company
  -- cannot be deleted without first removing its owner, and the guard that
  -- stops that is one worth keeping. The digits are stripped when the prefix
  -- is derived, so every run still numbers from YEM.
  insert into app.companies (name, registration_no, address)
  values ('Yemisi Holdings ' || to_char(clock_timestamp(), 'HH24MISSMS'),
          'RC 9' || to_char(clock_timestamp(), 'HH24MISSMS'), 'Ikeja')
  returning id into v_co;
  insert into app.memberships (company_id, user_id, role)
  values (v_co, '11111111-1111-1111-1111-111111111111', 'owner');

  -- Numbered by hand, as a register migrated from a spreadsheet would be.
  insert into app.locations (company_id, name, kind)
  values (v_co, 'Ikeja Store', 'physical');
  insert into app.assets (company_id, tag, name, location_id, status)
  values (v_co, 'YEM-00412', 'Counted by hand',
          (select id from app.locations where company_id = v_co limit 1), 'active');

  v_tag := app.next_asset_tag(v_co);
  return v_tag;
end $$;
set role authenticated;

select t.eq(t.seed_from_existing(), 'YEM-00413',
            'a register already numbered to 412 carries on at 413, not at 1');

-- ── a tag typed far ahead by hand is stepped over, not collided with ────────
reset role;
create or replace function t.jump_past_handwritten() returns text
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare v_co uuid; v_tag text; v_n int;
begin
  select id into v_co from app.companies where name like 'Yemisi Holdings%'
   order by created_at desc limit 1;

  -- Somebody has already labelled the next number by hand. The counter is at 413, so the
  -- next few generated numbers are free, and then the collision check has to
  -- notice rather than step one at a time through 8,500 numbers.
  insert into app.assets (company_id, tag, name, location_id, status)
  values (v_co, 'YEM-00414', 'Labelled by hand',
          (select id from app.locations where company_id = v_co limit 1), 'active');

  v_tag := app.next_asset_tag(v_co);
  v_n := substring(v_tag from '^YEM-(\d+)$')::int;
  return case
    when v_tag = 'YEM-00414' then 'collided'
    when v_n > 414 then 'stepped over'
    else 'unexpected ' || v_tag end;
end $$;
set role authenticated;

select t.eq(t.jump_past_handwritten(), 'stepped over',
            'a number already taken by hand is not issued a second time');

-- ── issuing a tag does not get slower as the register grows ─────────────────
-- The assertion that would have caught the quadratic version, and the one that
-- would have caught the ON CONFLICT version too. Phrased as a ratio rather
-- than a wall clock figure, so it means the same thing on a slow machine.
reset role;
create or replace function t.tag_cost_ratio() returns numeric
language plpgsql security definer set search_path = app, public, pg_temp as $$
declare
  v_co    uuid;
  v_small numeric;
  v_large numeric;
  v_t0    timestamptz;
begin
  select id into v_co from app.companies where name like 'Yemisi Holdings%'
   order by created_at desc limit 1;

  v_t0 := clock_timestamp();
  perform app.next_asset_tag(v_co) from generate_series(1, 200);
  v_small := extract(epoch from clock_timestamp() - v_t0);

  -- Four thousand assets, so any per-call scan of the register becomes
  -- impossible to miss.
  insert into app.assets (company_id, tag, name, location_id, status)
  select v_co, 'YEM-' || lpad((50000 + g)::text, 5, '0'), 'Bulk ' || g,
         (select id from app.locations where company_id = v_co limit 1), 'active'
    from generate_series(1, 4000) g;
  analyze app.assets;

  v_t0 := clock_timestamp();
  perform app.next_asset_tag(v_co) from generate_series(1, 200);
  v_large := extract(epoch from clock_timestamp() - v_t0);

  -- Guard against dividing by a figure too small to mean anything.
  return round((greatest(v_large, 0.0005) / greatest(v_small, 0.0005))::numeric, 2);
end $$;
set role authenticated;

-- A constant time generator lands near 1. The quadratic version measured over
-- 40 on this same test. Ten leaves room for a noisy machine while still
-- failing long before an import could reach a hosting timeout.
select t.ok(t.tag_cost_ratio() < 10,
            'issuing a tag costs the same on a 4,000 asset register as on an empty one');

-- ── the counter cannot be set from outside the generator ────────────────────
-- A client that could write it could set it back and reissue a live tag.
select t.ok((select count(*) from pg_policies
              where schemaname = 'app' and tablename = 'asset_tag_counters'
                and cmd <> 'SELECT') = 0,
            'nothing but the generator can advance the counter');

select t.eq((select count(*)::int > 0 from app.asset_tag_counters
              where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), true,
            'but a member can read their own numbering');
