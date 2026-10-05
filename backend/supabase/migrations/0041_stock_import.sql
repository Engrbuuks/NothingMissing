-- ============================================================================
-- 0041_stock_import.sql
-- Importing inventory from a spreadsheet.
--
-- Assets have had a spreadsheet import since 0024. Inventory never did, so a
-- company with four hundred lines of consumables had to type them one at a
-- time through a form built for adding one thing. In practice that means the
-- stock side of the register simply does not get populated, and a half
-- populated register is one nobody trusts enough to use.
--
-- This mirrors import_branch(): paste, preview, confirm. Same dry run, same
-- generous header matching in the parser, same all or nothing commit.
--
-- ============================================================================
-- THREE DECISIONS WORTH STATING
-- ============================================================================
--
-- 1. QUANTITIES GO THROUGH THE LEDGER, NOT INTO A BALANCE COLUMN.
--    app.stock_balances is a cache maintained by post_stock_movement(), which
--    0006 calls the single entry point precisely so the negative stock rule
--    and the balance cache cannot be bypassed. An import that wrote a balance
--    directly would be the one writer that skipped it. So an opening quantity
--    is posted as a `receipt` movement, which also means the opening figure
--    appears in the ledger with a date against it rather than materialising
--    from nowhere.
--
-- 2. A SKU THAT ALREADY EXISTS IS REJECTED, NOT TOPPED UP.
--    The alternative is that re-running the same file silently doubles every
--    balance, and nobody notices until a count. Rejecting means a re-run is a
--    no-op that reports what it skipped, which is the safe direction to fail.
--    Adding to an existing balance is receiving a delivery, and that has its
--    own screen with a reason and an audit row.
--
-- 3. ITEMS THAT LOOK LIKE ASSETS ARE FLAGGED, NOT REFUSED.
--    classification_hint() already warns when somebody creates a stock item
--    called "laptop". The import reports those rows as warnings and imports
--    them anyway, because a company that genuinely counts its monitors is not
--    wrong, and software that refuses what it merely disagrees with is
--    software people stop reading.
-- ============================================================================

-- ======================================================== one rule, one place
-- Whether a unit measures something continuous. It decided whether decimals
-- are allowed, and it lived only in createStockItem() in TypeScript, so the
-- import would have been a second copy of it, free to drift. Now both ask the
-- database.
create or replace function app.unit_is_divisible(p_unit text)
returns boolean
language sql immutable as $$
  select lower(btrim(coalesce(p_unit, ''))) in (
    'litre','litres','l','kg','kilogram','kilograms','g','gram','grams',
    'metre','metres','meter','meters','m','km','ml','tonne','tonnes','ton',
    'gallon','gallons','cubic metre','cubic metres','m3','hour','hours'
  )
$$;

grant execute on function app.unit_is_divisible(text) to authenticated;

-- ================================================================== import ==
-- p_rows is [{"sku":…, "name":…, "category":…, "unit":…, "qty":…,
--             "reorder":…, "cost":…}, …]
--
-- Only name is required. Everything else is optional and gets a sensible
-- default, for the same reason the asset import only requires a name: a file
-- that is refused for a missing column is a file nobody imports.
create or replace function app.import_stock(
  p_company       uuid,
  p_location_name text,
  p_rows          jsonb,
  p_commit        boolean default false
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_loc      uuid;
  v_new_loc  boolean := false;
  v_row      jsonb;
  v_i        int := 0;
  v_name     text;
  v_sku      text;
  v_unit     text;
  v_qty      numeric;
  v_cost     bigint;
  v_reorder  numeric;
  v_item     uuid;
  v_created  int := 0;
  v_posted   numeric := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  -- Tracked rather than queried, because a dry run writes nothing and so
  -- cannot see its own earlier rows. 0024 shipped with exactly this bug: the
  -- preview counted six new brands for a file naming two.
  v_seen     text[] := '{}';
  v_hint     jsonb;
begin
  if not app.can_write(p_company) then
    raise exception 'not permitted to import stock' using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_location_name, '')), '') is null then
    raise exception 'name the location this stock is held at'
      using errcode = 'check_violation';
  end if;

  -- ---------- the location, created if it is new ---------------------------
  select id into v_loc from app.locations
   where company_id = p_company and lower(name) = lower(btrim(p_location_name))
     and archived_at is null;

  if v_loc is null then
    v_new_loc := true;
    if p_commit then
      insert into app.locations (company_id, name)
      values (p_company, btrim(p_location_name))
      returning id into v_loc;
    end if;
  end if;

  if v_loc is not null and not app.can_access_location(p_company, v_loc) then
    raise exception 'you cannot hold stock at that location' using errcode = '42501';
  end if;

  -- ---------- the rows -----------------------------------------------------
  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_i := v_i + 1;

    v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    if v_name is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'reason', 'No name. Every line needs something to call it.');
      continue;
    end if;

    -- A code is generated when the file has none, the same way a tag is. Most
    -- spreadsheets have no SKU column and refusing over it would be pedantry.
    v_sku := nullif(btrim(coalesce(v_row ->> 'sku', '')), '');
    if v_sku is null then
      v_sku := upper(left(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g'), 6))
               || '-' || lpad(v_i::text, 4, '0');
    end if;

    if lower(v_sku) = any(v_seen) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'sku', v_sku, 'name', v_name,
        'reason', 'This code appears twice in the file.');
      continue;
    end if;

    if exists (select 1 from app.stock_items
                where company_id = p_company and lower(sku) = lower(v_sku)) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'sku', v_sku, 'name', v_name,
        'reason', 'An item with this code already exists. Receiving more of it '
               || 'is a delivery, not an import, so this row was left alone.');
      continue;
    end if;

    v_seen := v_seen || lower(v_sku);

    v_unit := coalesce(nullif(btrim(coalesce(v_row ->> 'unit', '')), ''), 'units');

    -- Strips currency symbols, thousands separators and stray text, so a cell
    -- reading "NGN 4,500" is 4500 rather than a refusal.
    v_qty := coalesce(
      nullif(regexp_replace(coalesce(v_row ->> 'qty', ''), '[^0-9.]', '', 'g'), '')::numeric, 0);
    v_reorder := coalesce(
      nullif(regexp_replace(coalesce(v_row ->> 'reorder', ''), '[^0-9.]', '', 'g'), '')::numeric, 0);
    v_cost := nullif(regexp_replace(coalesce(v_row ->> 'cost', ''), '[^0-9]', '', 'g'), '')::bigint;

    if v_qty < 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'sku', v_sku, 'name', v_name,
        'reason', 'A negative opening quantity is not a quantity.');
      continue;
    end if;

    -- Whole units cannot arrive as a fraction. Caught here rather than by the
    -- constraint so the message names the row.
    if not app.unit_is_divisible(v_unit) and v_qty <> trunc(v_qty) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'sku', v_sku, 'name', v_name,
        'reason', format('%s is counted in whole %s, so %s is not a valid quantity.',
                          v_name, v_unit, v_qty));
      continue;
    end if;

    v_hint := app.classification_hint(v_name);
    if (v_hint ->> 'warn')::boolean then
      v_warnings := v_warnings || jsonb_build_object(
        'row', v_i, 'name', v_name,
        'message', v_hint ->> 'message', 'detail', v_hint ->> 'detail');
    end if;

    v_created := v_created + 1;
    v_posted  := v_posted + v_qty;

    if p_commit then
      insert into app.stock_items
        (company_id, sku, name, category, unit, is_divisible,
         reorder_point, unit_cost_minor)
      values
        (p_company, v_sku, v_name,
         nullif(btrim(coalesce(v_row ->> 'category', '')), ''),
         v_unit, app.unit_is_divisible(v_unit),
         v_reorder, case when v_cost is not null then v_cost * 100 else null end)
      returning id into v_item;

      -- Through the ledger, never into the balance cache. The opening figure
      -- then has a movement behind it like every other number in the system.
      if v_qty > 0 then
        perform app.post_stock_movement(
          v_item, v_loc, 'receipt', v_qty,
          'opening balance, imported from a spreadsheet');
      end if;
    end if;
  end loop;

  if p_commit then
    -- Both casts are load bearing. A bare null is `unknown` and a CASE over
    -- two string literals is `unknown` too, so without them this resolves to
    -- no function at all and fails at runtime rather than at deploy. The dry
    -- run never reaches this line, which is how it passed a preview and broke
    -- on commit.
    perform app.log(p_company, 'imported stock', 'stock_items', null::text,
      btrim(p_location_name),
      format('%s item(s) created at %s, %s unit(s) received as opening balances, %s row(s) rejected',
             v_created, btrim(p_location_name), v_posted, jsonb_array_length(v_errors)),
      (case when jsonb_array_length(v_errors) > 0 then 'warn' else 'ok' end)::app.audit_tone,
      v_loc);
  end if;

  return jsonb_build_object(
    'committed',       p_commit,
    'location',        btrim(p_location_name),
    'location_is_new', v_new_loc,
    'items',           v_created,
    'units',           v_posted,
    'rejected',        jsonb_array_length(v_errors),
    'errors',          v_errors,
    'warnings',        v_warnings);
end $$;

revoke all on function app.import_stock(uuid, text, jsonb, boolean) from public;
grant execute on function app.import_stock(uuid, text, jsonb, boolean) to authenticated;
