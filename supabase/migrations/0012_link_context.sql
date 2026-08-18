-- ============================================================================
-- 0012_link_context.sql
--
-- The field page rendered its heading and then nothing at all.
--
-- Both forms were gated on having data — the stock item list for a count, the
-- asset list for a fault report — and the page queried those tables directly
-- as anon. Anon is denied on every table, correctly, so both queries returned
-- nothing and both forms silently disappeared. The visitor got a heading, a
-- footer, and no way to do anything.
--
-- The fix is not to grant anon access to those tables. It is to give the link
-- exactly the context it needs and nothing else, through a function that takes
-- the token and returns only what belongs to that link's own location:
--
--   * stock items, with names and units — but NOT quantities. A counter who
--     can see the expected figure will agree with it, and the count is then
--     worthless. Blind counting is the whole point.
--   * assets at that location, tag and name only — no cost, no serial, no
--     history, no holder.
--
-- Anything the link was not granted comes back empty, so a count-only link
-- cannot enumerate the asset register.
-- ============================================================================

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
begin
  select * into v_link from app.resolve_link(p_token);
  if not found then
    -- Same answer for expired, revoked, over-quota and unknown. Telling the
    -- caller which one lets them probe for valid tokens.
    return jsonb_build_object('valid', false);
  end if;

  select name into v_loc from app.locations where id = v_link.location_id;
  select name into v_holder from app.link_holders where id = v_link.holder_id;
  select name, brand_hex into v_co from app.companies where id = v_link.company_id;

  -- Names and units only. Never a quantity: see the note above.
  if 'count' = any(v_link.verbs) then
    select coalesce(jsonb_agg(jsonb_build_object('sku', i.sku, 'name', i.name, 'unit', i.unit)
                              order by i.sku), '[]'::jsonb)
      into v_items
    from app.stock_items i
    where i.company_id = v_link.company_id and i.archived_at is null;
  else
    v_items := '[]'::jsonb;
  end if;

  -- Only assets physically at this link's location, and only enough to
  -- identify one. A fault report does not need cost or custody history.
  if 'fault' = any(v_link.verbs) or 'transfer_request' = any(v_link.verbs) then
    select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'tag', a.tag, 'name', a.name)
                              order by a.tag), '[]'::jsonb)
      into v_assets
    from app.assets a
    where a.company_id = v_link.company_id
      and a.location_id = v_link.location_id
      and a.status <> 'retired';
  else
    v_assets := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'valid',    true,
    'location', v_loc,
    'holder',   v_holder,
    'company',  v_co.name,
    'brand',    v_co.brand_hex,
    'verbs',    to_jsonb(v_link.verbs::text[]),
    'items',    v_items,
    'assets',   v_assets);
end $$;

comment on function app.link_context is
  'Everything the field page needs, scoped to one link. Stock items carry no quantities: a counter who can see the expected figure will agree with it.';

grant execute on function app.link_context(text) to anon, authenticated;
