-- ============================================================================
-- 0045_tag_counter.sql
-- Issuing a tag in constant time.
--
-- app.next_asset_tag() read the highest number already used, which meant a
-- regular expression scan across every asset in the company. Fine for one
-- asset added through a form. Quadratic for an import, because it runs once
-- per asset created:
--
--     1,600 assets into an empty register      4.4 s
--     1,600 more, register now holds 1,608    11.9 s
--     1,600 more, register now holds 3,208    19.3 s
--
-- A hosted function is killed at ten to fifteen seconds, so a real import of
-- a real register does not fail, it simply stops: the button appears to do
-- nothing, nothing is written, and there is no error to read. That is the
-- worst shape a failure can take.
--
-- A counter makes each call an indexed update returning one row, independent
-- of how many assets exist. It also fixes something I flagged as a known
-- limitation when the max() version shipped: max() falls back when the highest
-- numbered assets are deleted, so their numbers came round again and a printed
-- label could end up naming a different object. A counter only goes up.
--
-- The expensive scan still happens exactly once per company, to seed the
-- counter from the numbering already in use, so an existing register carries
-- on from where it is rather than restarting at one.
-- ============================================================================

create table if not exists app.asset_tag_counters (
  company_id uuid not null references app.companies(id) on delete cascade,
  prefix     text not null,
  last_value int  not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, prefix)
);

comment on table app.asset_tag_counters is
  'One row per company and tag prefix. Seeded once from the highest tag '
  'already issued, then incremented. Never decreases, so a number belonging '
  'to a deleted asset is retired rather than reissued to a different object.';

alter table app.asset_tag_counters enable row level security;
alter table app.asset_tag_counters force row level security;

-- Readable by members so the numbering is inspectable. No write policy at
-- all: the counter is advanced only by next_asset_tag(), which is SECURITY
-- DEFINER. A client that could set it directly could reissue a live tag.
drop policy if exists tag_counters_select on app.asset_tag_counters;
create policy tag_counters_select on app.asset_tag_counters
  for select using (app.is_member(company_id));

-- Makes the one time seeding scan an index scan rather than a sequential one.
create index if not exists assets_company_tag_idx on app.assets (company_id, tag);

create or replace function app.next_asset_tag(p_company uuid)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_prefix text;
  v_next   int;
  v_tag    text;
  v_tries  int := 0;
begin
  select coalesce(nullif(regexp_replace(upper(c.name), '[^A-Z]', '', 'g'), ''), 'NM')
    into v_prefix
    from app.companies c where c.id = p_company;
  v_prefix := left(coalesce(v_prefix, 'NM'), 3);

  -- Seed once, from the numbering already in use.
  --
  -- The existence check is load bearing, not defensive. An
  --
  --     insert ... select max(...) ... on conflict do nothing
  --
  -- still evaluates its SELECT on every call: ON CONFLICT discards the row
  -- after the scan has been paid for. Written that way the counter advanced
  -- correctly and the import stayed exactly as quadratic as before: 5.1 s,
  -- 12.5 s, 21.0 s for three identical files. That is a worse bug than the one
  -- it replaced, because the code reads as though it were fixed.
  --
  -- Asking first turns the scan into one cheap index probe per call.
  if not exists (
    select 1 from app.asset_tag_counters
     where company_id = p_company and prefix = v_prefix
  ) then
    insert into app.asset_tag_counters (company_id, prefix, last_value)
    select p_company, v_prefix,
           coalesce(max(substring(a.tag from '^' || v_prefix || '-(\d+)$')::int), 0)
      from app.assets a
     where a.company_id = p_company
       and a.tag ~ ('^' || v_prefix || '-\d+$')
    on conflict (company_id, prefix) do nothing;
  end if;

  loop
    v_tries := v_tries + 1;

    -- The row lock here is what serialises two people adding at the same
    -- moment: the second waits for the first to commit rather than reading
    -- the same number.
    update app.asset_tag_counters
       set last_value = last_value + 1, updated_at = now()
     where company_id = p_company and prefix = v_prefix
     returning last_value into v_next;

    v_tag := v_prefix || '-' || lpad(v_next::text, 5, '0');

    -- A tag typed by hand can sit above the counter, so the generated one is
    -- still checked. In the normal case this is a single index probe and the
    -- loop runs once.
    exit when not exists (
      select 1 from app.assets a
       where a.company_id = p_company and a.tag = v_tag
    );

    -- Somebody has hand numbered far ahead. Rather than stepping one at a
    -- time through thousands of numbers, jump the counter past the highest
    -- in use and carry on.
    if v_tries >= 3 then
      update app.asset_tag_counters c
         set last_value = greatest(c.last_value, (
               select coalesce(max(substring(a.tag from '^' || v_prefix || '-(\d+)$')::int), 0)
                 from app.assets a
                where a.company_id = p_company and a.tag ~ ('^' || v_prefix || '-\d+$')))
       where c.company_id = p_company and c.prefix = v_prefix;
    end if;

    if v_tries > 50 then
      -- Never block an import over a tag. A timestamped one is unique and
      -- obvious enough to find and correct later.
      v_tag := v_prefix || '-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS');
      exit;
    end if;
  end loop;

  return v_tag;
end $$;

revoke all on function app.next_asset_tag(uuid) from public;
grant execute on function app.next_asset_tag(uuid) to authenticated;

notify pgrst, 'reload schema';
