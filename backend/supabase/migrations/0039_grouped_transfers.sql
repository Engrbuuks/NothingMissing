-- ============================================================================
-- 0039_grouped_transfers.sql
-- Moving ten of a thing without ticking ten boxes.
--
-- The transfer picker listed every asset individually — up to 300 checkboxes,
-- not even filtered to the origin you had chosen. That was tolerable while a
-- register was built one generator at a time. It stopped being tolerable the
-- moment quantity entry landed: typing 50 into the add-asset form produces 50
-- rows named "Task chair", and moving twelve of them to a branch meant finding
-- and ticking twelve indistinguishable lines in a list of fifty.
--
-- ============================================================================
-- WHAT DOES NOT CHANGE
-- ============================================================================
-- Grouping is a way of CHOOSING assets, not a way of storing them. A transfer
-- still moves named rows: every line names one asset, with one tag, one
-- history and one custody chain, and the waybill still lists them. Nothing
-- downstream learns about groups — dispatch_transfer() re-checks each asset is
-- still at the origin and still active, exactly as before.
--
-- This matters because the alternative is seductive and wrong: a transfer line
-- holding "Task chair × 12" would be unable to say which twelve, so a
-- discrepancy on arrival ("eleven came") could not name the missing one, and a
-- register that cannot name what is missing is the thing this product exists
-- to prevent.
--
-- ============================================================================
-- WHICH TWELVE
-- ============================================================================
-- Somebody has to choose, and it must be deterministic and it must be
-- concurrency-safe. Two storekeepers both moving 3 of the same 10 chairs at
-- the same moment must not both be handed the same three — they would
-- collide on the unique (transfer_id, asset_id) only if it were the SAME
-- transfer, which it is not, so nothing would catch it and six chairs would be
-- promised where three exist.
--
-- `for update skip locked` is the fix: the second caller's query steps over
-- the rows the first has locked and takes the next three instead. Ordered by
-- tag, so the choice is stable and the oldest numbers leave first.
-- ============================================================================

-- ====================================================== already spoken for ==
-- An asset on an open transfer is not available, even though it is still
-- sitting at the origin with status 'active'. A draft reserves nothing in the
-- data model — the asset only moves at dispatch — so without this the picker
-- would report fifty chairs while twelve of them are already on a manifest,
-- somebody would draft another twelve, and the collision would surface at
-- dispatch as "12 asset(s) are no longer available", days later and at the
-- wrong end of the process.
--
-- Open means drafted, waiting for approval, approved, or on the road.
-- Received, cancelled and rejected transfers release their assets.
create or replace function app.asset_is_spoken_for(p_asset uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (
    select 1
      from app.transfer_lines tl
      join app.transfers t on t.id = tl.transfer_id
     where tl.asset_id = p_asset
       and t.status in ('draft','pending','approved','in_transit')
  )
$$;

revoke all on function app.asset_is_spoken_for(uuid) from public;
grant execute on function app.asset_is_spoken_for(uuid) to authenticated;

-- ============================================================== the groups ==
-- Identical things at one location, collapsed. "Identical" is name + catalog
-- model, because those are what the register claims make two things the same
-- kind of thing. Serial numbers deliberately do not split a group: a group of
-- ten where three happen to have serials recorded is still ten chairs, and the
-- count of serials is returned so the page can say so rather than pretend.
create or replace function app.asset_groups(p_location uuid)
returns table (
  group_key    text,
  name         text,
  model_id     uuid,
  model_name   text,
  brand_name   text,
  category     text,
  available    bigint,
  with_serial  bigint,
  sample_tags  text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select
    -- A stable identifier for the form to post back. Built from the two
    -- things that define the group, so it cannot drift from the grouping.
    a.name || '|' || coalesce(a.model_id::text, '') as group_key,
    a.name,
    a.model_id,
    m.name  as model_name,
    b.name  as brand_name,
    coalesce(mc.name, ac.name) as category,
    count(*) as available,
    count(a.serial_no) as with_serial,
    -- The first few tags, so somebody can see what they are about to move
    -- without expanding the row.
    string_agg(a.tag, ', ' order by a.tag) filter (where true) as sample_tags
  from app.assets a
  left join app.models m on m.id = a.model_id
  left join app.brands b on b.id = m.brand_id
  left join app.sub_categories msc on msc.id = m.sub_category_id
  left join app.categories mc on mc.id = msc.category_id
  left join app.sub_categories asc_ on asc_.id = a.sub_category_id
  left join app.categories ac on ac.id = asc_.category_id
  where a.location_id = p_location
    and a.status = 'active'
    and app.is_member(a.company_id)
    and not app.asset_is_spoken_for(a.id)
  group by a.name, a.model_id, m.name, b.name, coalesce(mc.name, ac.name)
  order by count(*) desc, a.name
$$;

revoke all on function app.asset_groups(uuid) from public;
grant execute on function app.asset_groups(uuid) to authenticated;

-- =========================================================== the transfer ===
-- p_lines is [{"name": "Task chair", "model_id": null, "qty": 12}, ...]
-- p_assets is an optional list of specific asset ids, for the cases where it
-- has to be THAT generator and not just any one of them. Both may be supplied:
-- somebody moving twelve chairs and one named generator does it in one go.
create or replace function app.create_grouped_transfer(
  p_from    uuid,
  p_to      uuid,
  p_lines   jsonb default '[]'::jsonb,
  p_assets  uuid[] default '{}',
  p_reason  text default null,
  p_driver  text default null,
  p_plate   text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company  uuid;
  v_ref      text;
  v_transfer uuid;
  v_line     jsonb;
  v_name     text;
  v_model    uuid;
  v_qty      int;
  v_got      int;
  v_total    int := 0;
begin
  select company_id into v_company from app.locations where id = p_from;
  if v_company is null then
    raise exception 'that origin could not be read' using errcode = 'no_data_found';
  end if;

  if not app.can_write(v_company) then
    raise exception 'not permitted to move assets' using errcode = '42501';
  end if;
  if not app.can_access_location(v_company, p_from) then
    raise exception 'you cannot move assets out of that location' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'the origin and the destination are the same place'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from app.locations
                  where id = p_to and company_id = v_company and archived_at is null) then
    raise exception 'that destination is not a live location of this company'
      using errcode = 'check_violation';
  end if;

  v_ref := app.next_doc_number(v_company, 'request');

  insert into app.transfers
    (company_id, reference, from_location, to_location, status,
     reason, driver_name, vehicle_reg, requested_by)
  values
    (v_company, v_ref, p_from, p_to, 'draft',
     nullif(btrim(p_reason), ''), nullif(btrim(p_driver), ''),
     nullif(btrim(p_plate), ''), auth.uid())
  returning id into v_transfer;

  -- ---------- named assets, for when it has to be that one ----------------
  if coalesce(array_length(p_assets, 1), 0) > 0 then
    insert into app.transfer_lines (company_id, transfer_id, asset_id)
    select v_company, v_transfer, a.id
      from app.assets a
     where a.id = any(p_assets)
       and a.company_id = v_company
       and a.location_id = p_from
       and a.status = 'active'
       and not app.asset_is_spoken_for(a.id)
    on conflict (transfer_id, asset_id) do nothing;

    get diagnostics v_got = row_count;
    v_total := v_total + v_got;

    if v_got <> coalesce(array_length(p_assets, 1), 0) then
      raise exception '% of the % assets you named are not available at the origin',
        coalesce(array_length(p_assets, 1), 0) - v_got, coalesce(array_length(p_assets, 1), 0)
        using errcode = 'check_violation',
              hint = 'They may have moved, gone for repair, or already be on another open transfer.';
    end if;
  end if;

  -- ---------- quantities, chosen for you ----------------------------------
  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    v_name  := v_line ->> 'name';
    v_model := nullif(v_line ->> 'model_id', '')::uuid;
    v_qty   := coalesce((v_line ->> 'qty')::int, 0);

    continue when v_qty <= 0;

    -- `skip locked` is what makes two people moving from the same shelf at the
    -- same moment safe: the second caller steps over the rows the first has
    -- taken rather than selecting them again.
    --
    -- Assets already named above are excluded so a request for "that generator
    -- plus 3 generators" means four, not three with one counted twice.
    with picked as (
      select a.id
        from app.assets a
       where a.company_id = v_company
         and a.location_id = p_from
         and a.status = 'active'
         and a.name = v_name
         and a.model_id is not distinct from v_model
         and not exists (
           select 1 from app.transfer_lines tl
            where tl.transfer_id = v_transfer and tl.asset_id = a.id)
         -- Not already on somebody else's open manifest.
         and not app.asset_is_spoken_for(a.id)
       order by a.tag
       limit v_qty
       for update skip locked
    )
    insert into app.transfer_lines (company_id, transfer_id, asset_id)
    select v_company, v_transfer, picked.id from picked;

    get diagnostics v_got = row_count;
    v_total := v_total + v_got;

    if v_got < v_qty then
      -- Rolls the whole transfer back. A manifest that silently contains nine
      -- when twelve were asked for is worse than an error: it is discovered at
      -- the receiving end, by somebody who cannot tell whether three were
      -- stolen or never sent.
      raise exception 'only % of % × % available at the origin', v_got, v_qty, v_name
        using errcode = 'check_violation',
              hint = 'Someone may be moving the same items right now, or they went for repair.';
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'nothing was selected to move' using errcode = 'check_violation';
  end if;

  perform app.log(v_company, 'drafted a transfer', 'transfers', v_transfer::text, v_ref,
    format('%s asset(s) from %s to %s', v_total,
      (select name from app.locations where id = p_from),
      (select name from app.locations where id = p_to)),
    'info', p_from);

  return jsonb_build_object('transfer', v_transfer, 'reference', v_ref, 'lines', v_total);
end $$;

revoke all on function app.create_grouped_transfer(uuid, uuid, jsonb, uuid[], text, text, text) from public;
grant execute on function app.create_grouped_transfer(uuid, uuid, jsonb, uuid[], text, text, text) to authenticated;
