-- ============================================================================
-- 0028_fuel_fleet.sql
-- Making the fuel check reachable.
--
-- `fuel_reconciliation()` has existed since 0006 and works correctly, but it
-- takes ONE asset id — so using it means already knowing which generator to
-- suspect, which is precisely the thing you do not know. Nothing in the
-- application called it. The marketing site sells "shrinkage you can find" and
-- the product had no screen for it.
--
-- This is the fleet version: every metered asset that consumed fuel in a
-- window, with the gap in litres, sorted worst first. That is a page somebody
-- can open on a Monday and act on.
--
-- The verdict thresholds are deliberately forgiving. A dipstick on a 2,000
-- litre tank is not accurate to the litre, generators idle, and a hard rule
-- would flag every honest depot in the country. Anything within 10% is normal;
-- 10–25% is worth a question; beyond that is worth a visit.
-- ============================================================================

create or replace function app.fuel_fleet(
  p_company uuid,
  p_from    timestamptz default now() - interval '30 days',
  p_to      timestamptz default now()
) returns table (
  asset_id      uuid,
  tag           text,
  name          text,
  location      text,
  hours_run     numeric,
  litres_issued numeric,
  litres_expected numeric,
  gap_litres    numeric,
  gap_pct       numeric,
  verdict       text,
  issues        int
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  with movements as (
    select
      sm.asset_id,
      sum(abs(sm.qty))                          as litres,
      count(*)                                  as issues,
      min(sm.meter_reading) filter (where sm.meter_reading is not null) as m_start,
      max(sm.meter_reading) filter (where sm.meter_reading is not null) as m_end
    from app.stock_movements sm
    join app.stock_items si on si.id = sm.item_id
    where sm.company_id = p_company
      and sm.kind = 'issue'
      and sm.asset_id is not null
      and sm.occurred_at between p_from and p_to
      -- Fuel only. Issuing gloves against a generator is not a fuel event, and
      -- counting it would make every reconciliation nonsense.
      and lower(si.unit) in ('litres', 'l')
    group by sm.asset_id
  ),
  calc as (
    select
      a.id, a.tag, a.name, l.name as loc,
      greatest(coalesce(mv.m_end - mv.m_start, 0), 0)            as hours,
      mv.litres,
      mv.issues,
      m.consumption_rate                                          as rate,
      case when m.consumption_rate is null then null
           else round(greatest(coalesce(mv.m_end - mv.m_start, 0), 0)
                      * m.consumption_rate, 1) end                as expected
    from movements mv
    join app.assets a on a.id = mv.asset_id
    left join app.locations l on l.id = a.location_id
    left join app.models m on m.id = a.model_id
    where app.is_member(a.company_id)
  )
  select
    id, tag, name, loc,
    hours,
    litres,
    expected,
    case when expected is null then null else round(litres - expected, 1) end,
    case when expected is null or expected = 0 then null
         else round(((litres - expected) / expected) * 100, 1) end,
    case
      -- No consumption rate on the model means nothing to compare against.
      -- Saying so is more useful than showing a blank row somebody puzzles at.
      when expected is null then 'no rate on the model'
      when hours = 0 then 'no meter readings'
      when expected = 0 then 'no run time recorded'
      when abs((litres - expected) / expected) <= 0.10 then 'normal'
      when (litres - expected) / expected > 0.25 then 'investigate'
      when (litres - expected) / expected > 0.10 then 'worth a question'
      when (litres - expected) / expected < -0.25 then 'under-issued — check the meter'
      else 'normal'
    end,
    issues::int
  from calc
  order by
    case when expected is null or expected = 0 then 1 else 0 end,
    case when expected is null or expected = 0 then 0
         else (litres - expected) / expected end desc nulls last
$$;

grant execute on function app.fuel_fleet(uuid, timestamptz, timestamptz) to authenticated;

comment on function app.fuel_fleet is
  'Fuel issued against what each metered engine could have burned, fleet-wide. '
  'The per-asset version in 0006 needed you to already know which machine to '
  'suspect, which is the thing you do not know.';
