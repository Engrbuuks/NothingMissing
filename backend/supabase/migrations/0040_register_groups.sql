-- ============================================================================
-- 0040_register_groups.sql
-- The register, batched.
--
-- Forty identical Lenovos produced forty identical rows. Same name, same
-- category, same location, same status, same holder, differing only by a tag
-- nobody asked for and nobody reads. Scrolling past thirty five of them to
-- reach the generators is not a register, it is a receipt roll.
--
-- What a person wants to know on that screen is "forty Lenovos at Osun".
-- One line, with the number in front of it. Move twelve to Lagos and Osun
-- reads twenty eight, because twelve rows changed location.
--
-- ============================================================================
-- WHY THIS IS A VIEW AND NOT A SCHEMA CHANGE
-- ============================================================================
-- The obvious alternative is to stop creating a row per unit and hold a
-- quantity instead. It is the wrong trade, for one reason that outweighs the
-- rest: a row with a quantity cannot answer "which one".
--
--   * A transfer of twelve that arrives as eleven has to name the missing
--     unit, or the discrepancy says a number went missing and nothing else.
--   * One Lenovo goes for repair. With a quantity you write 39 and 1 and
--     have lost which machine is on the bench.
--   * One is sold, one is stolen, one is assigned to Gabriel and one to Musa.
--     Each of those is a fact about a unit, not about a count.
--
-- So the rows stay. Nobody has to look at them. The tag is still generated
-- (0035) because the audit log, the waybill and the discrepancy all need
-- something to name, but it is no longer the first column of the register and
-- it is not something anybody types.
--
-- ============================================================================
-- WHY IT GROUPS IN THE DATABASE
-- ============================================================================
-- Grouping twenty thousand rows in the browser means sending twenty thousand
-- rows to the browser. The register has carried a 500 row ceiling precisely
-- because of that, which quietly means a large company sees a partial
-- register. Grouping here returns forty lines for forty thousand assets, and
-- the ceiling stops mattering.
--
-- SECURITY INVOKER, deliberately, which is to say no SECURITY DEFINER marker
-- at all. Row level security on app.assets and app.asset_financials applies to
-- whoever calls it, so a location manager sees their own site and a role that
-- cannot see money gets null in the cost column because the policy returns no
-- financial rows to sum. The gate is the database, not the page.
-- ============================================================================

create or replace function app.register_groups(
  p_q      text default null,
  p_cat    uuid default null,
  p_loc    uuid default null,
  p_status text default null
)
returns table (
  group_key     text,
  name          text,
  model_id      uuid,
  model_name    text,
  brand_name    text,
  category_id   uuid,
  category_name text,
  location_id   uuid,
  location_name text,
  location_hex  text,
  status        text,
  holder        text,
  units         bigint,
  with_serial   bigint,
  cost_minor    bigint,
  sample_tags   text,
  first_asset   uuid
)
language sql stable as $$
  select
    -- Identifies the batch for a drill down. Built from the same columns the
    -- grouping uses, so the key and the grouping cannot drift apart.
    md5(
      coalesce(a.name,'') || '|' || coalesce(a.model_id::text,'') || '|' ||
      coalesce(a.location_id::text,'') || '|' || a.status::text || '|' ||
      coalesce(a.holder,'')
    ) as group_key,
    a.name,
    a.model_id,
    m.name as model_name,
    b.name as brand_name,
    coalesce(mc.id, ac.id)     as category_id,
    coalesce(mc.name, ac.name) as category_name,
    a.location_id,
    l.name as location_name,
    l.colour_hex as location_hex,
    a.status::text,
    a.holder,
    count(*)           as units,
    count(a.serial_no) as with_serial,
    -- Null for a caller whose role cannot read financials, because the policy
    -- hands them no rows rather than zeros. A blank column reads as withheld;
    -- a zero would read as free.
    sum(f.purchase_cost_minor) as cost_minor,
    -- Enough tags to recognise the batch without expanding it.
    (array_to_string((array_agg(a.tag order by a.tag))[1:4], ', ')) as sample_tags,
    (array_agg(a.id order by a.tag))[1] as first_asset
  from app.assets a
  left join app.models m          on m.id   = a.model_id
  left join app.brands b          on b.id   = m.brand_id
  left join app.sub_categories ms on ms.id  = m.sub_category_id
  left join app.categories mc     on mc.id  = ms.category_id
  left join app.sub_categories as_ on as_.id = a.sub_category_id
  left join app.categories ac     on ac.id  = as_.category_id
  left join app.locations l       on l.id   = a.location_id
  left join app.asset_financials f on f.asset_id = a.id
  where (p_loc    is null or a.location_id = p_loc)
    and (p_status is null or a.status::text = p_status)
    and (p_cat    is null or coalesce(mc.id, ac.id) = p_cat)
    and (
      p_q is null or btrim(p_q) = ''
      or a.name      ilike '%' || p_q || '%'
      or a.tag       ilike '%' || p_q || '%'
      or a.serial_no ilike '%' || p_q || '%'
      or a.holder    ilike '%' || p_q || '%'
    )
  group by
    a.name, a.model_id, m.name, b.name,
    coalesce(mc.id, ac.id), coalesce(mc.name, ac.name),
    a.location_id, l.name, l.colour_hex, a.status, a.holder
  order by count(*) desc, a.name, l.name
$$;

revoke all on function app.register_groups(text, uuid, uuid, text) from public;
grant execute on function app.register_groups(text, uuid, uuid, text) to authenticated;

comment on function app.register_groups is
  'The asset register collapsed to one line per batch of identical units. '
  'Deliberately not SECURITY DEFINER: row level security decides what is '
  'counted and whether the cost column has anything in it.';
