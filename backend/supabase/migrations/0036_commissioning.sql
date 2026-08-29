-- ============================================================================
-- 0036_commissioning.sql
-- The crossing between stock and the register.
--
-- "Can an asset double as inventory?" — one ROW cannot, and one THING very
-- often must, at different points in its life. Both halves of that matter.
--
-- Why not one row. A stock row is a balance per location with no identity: 40
-- at Lagos, 12 at Ibadan, and no answer to "which one". An asset row is one
-- object with one location, one holder, one meter, one custody chain and one
-- disposal. A row that is both needs every asset column nullable and a
-- quantity that is sometimes 1 — and then transfers, waybills, depreciation
-- and the audit log all have to ask "which kind am I?" before they can do
-- anything. That flag is the mess this schema was shaped to avoid.
--
-- Why the crossing is real anyway. Fifty chairs arrive and go into the store.
-- Nobody cares which is which, so they are stock — counting them is the only
-- sensible thing to do. Twelve are then issued to Ibadan and a branch manager
-- signs for them. From that moment somebody WILL ask where a specific one is,
-- because one will break and one will go missing. They have become assets.
--
-- Nothing modelled that. Stock could be issued, and issuing destroyed the
-- quantity — so the twelve chairs left the ledger and arrived nowhere. The
-- register and the store both told the truth and the company still could not
-- say where its chairs were.
--
-- `commission_stock()` is that transition, and `return_to_stock()` is the way
-- back for things that go into the store and become interchangeable again.
-- ============================================================================

-- ========================================================= commissioning ====
-- Draw p_qty from stock at a location and create that many tagged assets, in
-- one transaction. Half of this succeeding is the worst outcome available:
-- stock deducted with no assets created is inventory that has evaporated.
create or replace function app.commission_stock(
  p_item     uuid,
  p_location uuid,
  p_qty      int,
  p_name     text default null,
  p_model    uuid default null,
  p_holder   text default null,
  p_serials  text[] default null,
  p_note     text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_item   app.stock_items%rowtype;
  v_bal    numeric;
  v_name   text;
  v_ids    uuid[] := '{}';
  v_tags   text[] := '{}';
  v_id     uuid;
  v_tag    text;
  v_serial text;
  v_i      int;
begin
  select * into v_item from app.stock_items where id = p_item;
  if not found then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_item.company_id) then
    raise exception 'not permitted to commission stock' using errcode = '42501';
  end if;
  if not app.can_access_location(v_item.company_id, p_location) then
    raise exception 'you cannot act at that location' using errcode = '42501';
  end if;

  if p_qty is null or p_qty < 1 then
    raise exception 'commission at least one' using errcode = 'check_violation';
  end if;

  -- A divisible item is the honest refusal here. You cannot tag 40 litres of
  -- diesel: there is no object to put a label on, and the next 40 litres are
  -- the same 40 litres. If somebody is trying, the item is misclassified.
  if v_item.is_divisible then
    raise exception '% is measured in %, not counted as objects — it cannot become an asset',
      v_item.name, v_item.unit
      using errcode = 'check_violation',
            hint = 'Only countable items become assets. Fuel is issued to an asset, not turned into one.';
  end if;

  v_bal := app.stock_balance(p_item, p_location);
  if v_bal < p_qty then
    raise exception 'only % % of % at that location, cannot commission %',
      v_bal, v_item.unit, v_item.name, p_qty
      using errcode = 'check_violation';
  end if;

  -- Serials are optional, but a partial list is a mistake worth catching: it
  -- means somebody stopped typing halfway and the rest would silently get
  -- none, with no way afterwards to tell which.
  if p_serials is not null and cardinality(p_serials) <> p_qty then
    raise exception '% serial(s) supplied for % unit(s)',
      cardinality(p_serials), p_qty
      using errcode = 'check_violation',
            hint = 'Supply one serial per unit, or none at all and fill them in later.';
  end if;

  v_name := coalesce(nullif(btrim(p_name), ''), v_item.name);

  -- Deduct first. If asset creation fails, the whole transaction rolls back;
  -- doing it this way round means the negative-stock guard in
  -- post_stock_movement() runs before anything is created.
  perform app.post_stock_movement(
    p_item, p_location, 'issue', -p_qty::numeric,
    coalesce(p_note, 'commissioned into the asset register'));

  for v_i in 1 .. p_qty loop
    v_serial := case when p_serials is null then null
                     else nullif(btrim(p_serials[v_i]), '') end;

    insert into app.assets
      (company_id, tag, name, description, serial_no, model_id,
       location_id, status, holder)
    values
      (v_item.company_id, '', v_name,
       'Commissioned from stock: ' || v_item.name || ' (' || v_item.sku || ')',
       v_serial, p_model, p_location, 'active', nullif(btrim(p_holder), ''))
    returning id, tag into v_id, v_tag;

    v_ids  := v_ids  || v_id;
    v_tags := v_tags || v_tag;
  end loop;

  perform app.log(v_item.company_id, 'commissioned stock', 'assets',
    v_ids[1]::text, v_tags[1],
    format('%s × %s drawn from stock at this location and tagged as %s asset(s): %s',
           p_qty, v_item.name, p_qty, array_to_string(v_tags, ', ')),
    'ok', p_location);

  return jsonb_build_object(
    'created', p_qty,
    'asset_ids', to_jsonb(v_ids),
    'tags', to_jsonb(v_tags),
    'remaining', app.stock_balance(p_item, p_location)
  );
end $$;

revoke all on function app.commission_stock(uuid, uuid, int, text, uuid, text, text[], text) from public;
grant execute on function app.commission_stock(uuid, uuid, int, text, uuid, text, text[], text) to authenticated;

-- ============================================================ the way back ==
-- An asset returned to the store, becoming interchangeable again.
--
-- The asset is RETIRED rather than deleted. Its history — who held it, where
-- it went, what was spent repairing it — is the company's record and does not
-- stop being true because the thing went back on a shelf. Deleting the row
-- would make the audit trail reference an asset nobody can look up.
create or replace function app.return_to_stock(
  p_asset  uuid,
  p_item   uuid,
  p_reason text default null
) returns bigint
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_a    app.assets%rowtype;
  v_item app.stock_items%rowtype;
  v_mv   bigint;
begin
  select * into v_a from app.assets where id = p_asset for update;
  if not found then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;
  select * into v_item from app.stock_items where id = p_item;
  if not found then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;

  if v_item.company_id <> v_a.company_id then
    raise exception 'that stock item belongs to another company' using errcode = '42501';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- In transit means it belongs to neither register. Putting it back on a
  -- shelf it has not arrived at is how a discrepancy gets closed by accident.
  if v_a.status = 'transit' then
    raise exception 'that asset is in transit — receive it first'
      using errcode = 'check_violation';
  end if;
  if v_a.status = 'retired' then
    raise exception 'that asset is already retired' using errcode = 'check_violation';
  end if;
  if v_a.location_id is null then
    raise exception 'that asset is at no location, so there is nowhere to return it to'
      using errcode = 'check_violation';
  end if;

  v_mv := app.post_stock_movement(
    p_item, v_a.location_id, 'return', 1,
    coalesce(p_reason, 'returned to stock from asset ' || v_a.tag));

  update app.assets
     set status = 'retired', holder = null, holder_user_id = null
   where id = p_asset;

  perform app.log(v_a.company_id, 'returned an asset to stock', 'assets',
    p_asset::text, v_a.tag,
    format('%s returned to stock as %s. %s', v_a.tag, v_item.name,
           coalesce(p_reason, 'No reason given.')),
    'info', v_a.location_id);

  return v_mv;
end $$;

revoke all on function app.return_to_stock(uuid, uuid, text) from public;
grant execute on function app.return_to_stock(uuid, uuid, text) to authenticated;
