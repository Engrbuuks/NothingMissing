-- ============================================================================
-- 0025_reusable_links.sql
-- Making a field link genuinely reusable.
--
-- The bug: `used_count` is a lifetime counter, and `resolve_link()` compares it
-- against `max_per_month`. So a link issued with the default limit of 50 works
-- fifty times and then dies permanently — the storekeeper it was sent to finds
-- it dead one morning with no warning, and nobody can see why from the app.
--
-- A monthly allowance that never resets is not a monthly allowance. It is a
-- lifetime cap wearing the wrong name, which is worse than either, because
-- everything on screen says "monthly" and the behaviour says otherwise.
--
-- The fix counts actual submissions in the current calendar month rather than
-- keeping a counter. Submissions are already stored with a timestamp, so the
-- count is derivable and cannot drift from what the reviewer sees in the
-- inbox — the same reasoning as stock balances being derived from the ledger.
--
-- `used_count` stays as a lifetime total, because "this link has been used 340
-- times since March" is genuinely useful when deciding whether to revoke it.
-- It is just no longer what the limit is checked against.
-- ============================================================================

-- Submissions in the current calendar month for one link.
create or replace function app.link_used_this_month(p_link uuid)
returns int
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select count(*)::int
  from app.submissions s
  where s.link_id = p_link
    and s.submitted_at >= date_trunc('month', now())
$$;

-- resolve_link, corrected. Same signature, same shape, so nothing calling it
-- needs to change.
create or replace function app.resolve_link(p_token text)
returns table (link_id uuid, company_id uuid, location_id uuid,
               holder_id uuid, verbs app.link_verb[])
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select l.id, l.company_id, l.location_id, l.holder_id, l.verbs
  from app.location_links l
  where l.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and l.revoked_at is null
    and l.expires_on >= current_date
    -- Counted from the submissions themselves, in this calendar month. A
    -- counter that only ever goes up made every link single-lifetime.
    and (l.max_per_month is null
         or app.link_used_this_month(l.id) < l.max_per_month)
$$;

-- A link that is close to its limit should say so on the link itself, while
-- the person can still do something about it — not fail silently next week.
create or replace function app.link_context(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_link   record;
  v_items  jsonb;
  v_assets jsonb;
  v_loc    text;
  v_holder text;
  v_co     record;
  v_used   int;
  v_left   int;
begin
  select * into v_link from app.resolve_link(p_token);
  if not found then
    -- Same answer for expired, revoked, over-quota and unknown. Telling the
    -- caller which one lets them probe for valid tokens.
    return jsonb_build_object('valid', false);
  end if;

  select name into v_loc from app.locations where id = v_link.location_id;
  select name into v_holder from app.link_holders where id = v_link.holder_id;
  select name, brand_hex, logo_path into v_co
    from app.companies where id = v_link.company_id;

  -- Stock item names and units, never quantities. The whole point of a blind
  -- count is that the person counting does not know what is expected.
  select coalesce(jsonb_agg(jsonb_build_object(
           'sku', si.sku, 'name', si.name, 'unit', si.unit) order by si.name), '[]'::jsonb)
    into v_items
  from app.stock_items si
  where si.company_id = v_link.company_id and si.archived_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'tag', a.tag, 'name', a.name) order by a.tag), '[]'::jsonb)
    into v_assets
  from app.assets a
  where a.location_id = v_link.location_id and a.status <> 'retired';

  select max_per_month into v_left from app.location_links where id = v_link.link_id;
  v_used := app.link_used_this_month(v_link.link_id);

  return jsonb_build_object(
    'valid', true,
    'company', v_co.name,
    'brand_hex', v_co.brand_hex,
    'logo_path', v_co.logo_path,
    'location', v_loc,
    'holder', v_holder,
    'verbs', v_link.verbs,
    'items', v_items,
    'assets', v_assets,
    'used_this_month', v_used,
    'monthly_limit', v_left,
    -- Warned at five remaining, so somebody can ask for a new link before the
    -- old one stops working rather than after.
    'running_low', (v_left is not null and (v_left - v_used) <= 5));
end $$;

grant execute on function app.link_used_this_month(uuid) to anon, authenticated;
grant execute on function app.link_context(text) to anon, authenticated;

-- Existing links were issued under the broken rule and some are already past
-- their lifetime count. Their monthly usage is now what matters, so the stale
-- counters are reset to a true lifetime figure rather than left to mislead.
update app.location_links l
   set used_count = coalesce((
     select count(*) from app.submissions s where s.link_id = l.id), 0);

-- The default was 50 a month, which is tight for a busy depot doing daily fuel
-- readings plus counts. 300 is roughly ten a day — generous enough never to be
-- hit by honest use, low enough to cap a leaked link.
alter table app.location_links alter column max_per_month set default 300;

create or replace function app.issue_location_link(
  p_company   uuid,
  p_location  uuid,
  p_holder    uuid,
  p_verbs     app.link_verb[],
  p_expires   date default (current_date + 90),
  p_max_month int default 300
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_token text;
  v_slug  text;
  v_id    uuid;
  v_name  text;
  v_root  text := 'nothingmissing.ng';
begin
  if not app.has_role(p_company, 'owner', 'admin', 'manager') then
    raise exception 'Only an owner, admin or manager can issue a link.'
      using errcode = '42501';
  end if;

  if p_holder is not null and not exists (
    select 1 from app.link_holders where id = p_holder and company_id = p_company
  ) then
    raise exception 'That person is not on this company''s list.'
      using errcode = 'foreign_key_violation';
  end if;

  if p_expires <= current_date then
    raise exception 'The expiry has to be in the future.' using errcode = 'check_violation';
  end if;

  if p_expires > current_date + 365 then
    raise exception 'A year is the longest a link can live.'
      using errcode = 'check_violation',
            hint = 'A link nobody has thought about for a year is a link nobody is watching.';
  end if;

  select name into v_name from app.link_holders where id = p_holder;
  select slug into v_slug from app.companies where id = p_company;

  -- The token goes in the PATH, not a fragment. Browsers strip fragments
  -- before sending a request, so a token after # never reaches the server.
  v_token := encode(gen_random_bytes(24), 'hex');

  insert into app.location_links
    (company_id, location_id, holder_id, slug, token_hash, verbs,
     expires_on, max_per_month, created_by)
  values
    (p_company, p_location, p_holder, v_slug,
     encode(digest(v_token, 'sha256'), 'hex'), p_verbs,
     p_expires, p_max_month, auth.uid())
  returning id into v_id;

  perform app.log(p_company, 'issued a location link', 'location_links', v_id::text,
    coalesce(v_name, 'unnamed'),
    format('%s at %s, verbs: %s, expires %s', coalesce(v_name, 'unnamed'),
      (select name from app.locations where id = p_location),
      array_to_string(p_verbs::text[], ', '), p_expires),
    'info', p_location);

  return jsonb_build_object(
    'link_id', v_id,
    'token', v_token,
    'url', format('https://%s/l/%s', v_root, v_token),
    'expires_on', p_expires);
end $$;

grant execute on function app.issue_location_link(uuid, uuid, uuid, app.link_verb[], date, int)
  to authenticated;

-- What a manager needs to see about a link: is it working, how much of its
-- allowance is gone this month, and when did somebody last use it. A link
-- nobody has used in six weeks is either a person who has left or a process
-- that quietly stopped.
create or replace function app.link_health(p_company uuid)
returns table (
  link_id uuid, holder text, location text, verbs text[],
  expires_on date, days_left int, used_this_month int, monthly_limit int,
  last_used_at timestamptz, days_since_use int, state text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select
    l.id,
    coalesce(h.name, 'Unnamed'),
    loc.name,
    l.verbs::text[],
    l.expires_on,
    (l.expires_on - current_date)::int,
    app.link_used_this_month(l.id),
    l.max_per_month,
    l.last_used_at,
    case when l.last_used_at is null then null
         else extract(day from now() - l.last_used_at)::int end,
    case
      when l.revoked_at is not null then 'revoked'
      when l.expires_on < current_date then 'expired'
      when l.max_per_month is not null
           and app.link_used_this_month(l.id) >= l.max_per_month then 'at limit'
      when l.expires_on - current_date <= 7 then 'expiring soon'
      when l.last_used_at is null then 'never used'
      when l.last_used_at < now() - interval '30 days' then 'quiet'
      else 'working'
    end
  from app.location_links l
  join app.locations loc on loc.id = l.location_id
  left join app.link_holders h on h.id = l.holder_id
  where l.company_id = p_company
    and app.has_role(p_company, 'owner', 'admin', 'manager')
  order by
    case when l.revoked_at is not null then 2 else 1 end,
    l.expires_on
$$;

grant execute on function app.link_health(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A second bug, and the one behind "the single link does not let me do
-- anything": `unique (company_id, slug)` on location_links.
--
-- The slug column holds the COMPANY's slug, not a per-link value — it was
-- added back when the token lived in a URL of the form /l/<slug>#<token>, and
-- it survived the move to /l/<token> in 0011 without its constraint being
-- reconsidered.
--
-- The effect: a company could hold exactly ONE link, ever. Issuing a second
-- failed on a duplicate key, so a manager could not give one link to the
-- Ibadan storekeeper and another to Abuja — and the error said "duplicate key
-- value violates constraint", which tells the person nothing they can act on.
--
-- The token's own unique index is what actually guarantees uniqueness, and it
-- is untouched. This constraint was never doing that job.
-- ---------------------------------------------------------------------------
alter table app.location_links
  drop constraint if exists location_links_company_id_slug_key;

-- One live link per person per location is a real rule and worth keeping: two
-- live links for the same storekeeper means revoking one and wondering why
-- they can still submit. Partial, so revoked and expired links do not block a
-- replacement being issued.
create unique index if not exists links_one_live_per_holder
  on app.location_links (company_id, location_id, holder_id)
  where revoked_at is null and holder_id is not null;
