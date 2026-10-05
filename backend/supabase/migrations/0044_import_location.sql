-- ============================================================================
-- 0044_import_location.sql
-- A Location column on the asset import.
--
-- The import has always taken one location, typed on the page, and applied it
-- to every row. That is right for onboarding a branch. It is wrong for a
-- register that already spans rooms: fifteen hundred assets belonging to a
-- store, three operations floors and a server room all land in one place, and
-- the only way to correct it afterwards is to move them by hand.
--
-- A `Location` column now places each row. Blank falls back to the location
-- named on the page, so a file without the column behaves exactly as it did.
--
-- Two things worth stating:
--
--   * Permission is checked PER LOCATION rather than once for the file.
--     Otherwise somebody scoped to one site could place assets anywhere
--     simply by naming it in a spreadsheet, which is the sort of hole that
--     looks like a convenience feature right up until it is found.
--
--   * New locations named in the file are created, and the dry run counts
--     them without writing. It tracks the names it has already counted rather
--     than querying, because a preview cannot see its own earlier rows.
-- ============================================================================

create or replace function app.import_branch(
  p_company      uuid,
  p_location_name text,
  p_rows         jsonb,
  p_commit       boolean default false,
  p_location_id  uuid default null,
  p_city         text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_loc      uuid;
  v_new_loc  boolean := false;
  v_row      jsonb;
  v_i        int := 0;
  v_tag      text;
  v_name     text;
  v_serial   text;
  v_cat      uuid;
  v_sub      uuid;
  v_brand    uuid;
  v_model    uuid;
  v_asset    uuid;
  v_cost     bigint;
  v_created  int := 0;
  v_cats     int := 0;
  v_brands   int := 0;
  v_models   int := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_seen     text[] := '{}';
  v_seen_sn  text[] := '{}';
  v_new_cats text[] := '{}';
  v_new_brands text[] := '{}';
  v_new_models text[] := '{}';
  -- Dry run only. Nothing is written, so next_asset_tag() would hand back the
  -- same number for every row; this walks forward from it so the preview shows
  -- a plausible sequence rather than the same tag repeated.
  v_preview_n int := 0;
  v_qty       int;
  v_n         int;
  v_row_loc   text;
  v_use_loc   uuid;
  v_locs      int := 0;
  v_new_locs  text[] := '{}';
begin
  if not app.can_write(p_company) then
    raise exception 'not permitted to import' using errcode = '42501';
  end if;

  if p_location_id is not null then
    select id into v_loc from app.locations
     where id = p_location_id and company_id = p_company and archived_at is null;
    if v_loc is null then
      raise exception 'that location could not be read' using errcode = 'no_data_found';
    end if;
  else
    select id into v_loc from app.locations
     where company_id = p_company and lower(name) = lower(btrim(p_location_name))
       and archived_at is null;
    if v_loc is null then
      v_new_loc := true;
      if p_commit then
        insert into app.locations (company_id, name, city)
        values (p_company, btrim(p_location_name), nullif(btrim(coalesce(p_city,'')), ''))
        returning id into v_loc;
      end if;
    end if;
  end if;

  if v_loc is not null and not app.can_access_location(p_company, v_loc) then
    raise exception 'you cannot add assets at that location' using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_i := v_i + 1;

    v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    if v_name is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'reason', 'No name. Every line needs something to call it.');
      continue;
    end if;

    -- ---- which location this row goes to ----------------------------------
    -- A Location column lets one file place assets across several rooms or
    -- sites. Without it the whole file lands in one place, which for a
    -- fifteen hundred line register means re-filing by hand afterwards.
    -- Blank falls back to the location named on the import page, so a file
    -- with no Location column behaves exactly as before.
    v_row_loc := nullif(btrim(coalesce(v_row ->> 'location', '')), '');
    if v_row_loc is null or lower(v_row_loc) = lower(btrim(p_location_name)) then
      v_use_loc := v_loc;
    else
      select id into v_use_loc from app.locations
       where company_id = p_company and lower(name) = lower(v_row_loc)
         and archived_at is null;

      if v_use_loc is null then
        -- Counted once per distinct name. A dry run writes nothing, so it
        -- cannot see its own earlier rows by querying; 0024 shipped with
        -- exactly that bug and reported six new brands for a file naming two.
        if not (lower(v_row_loc) = any(v_new_locs)) then
          v_locs := v_locs + 1;
          v_new_locs := v_new_locs || lower(v_row_loc);
        end if;
        if p_commit then
          insert into app.locations (company_id, name)
          values (p_company, v_row_loc)
          returning id into v_use_loc;
        end if;
      end if;

      -- Checked per location, not once for the file. A person scoped to one
      -- site must not be able to place assets at another by naming it in a
      -- spreadsheet.
      if v_use_loc is not null and not app.can_access_location(p_company, v_use_loc) then
        v_errors := v_errors || jsonb_build_object(
          'row', v_i, 'name', v_name, 'location', v_row_loc,
          'reason', format('You cannot add assets at %s.', v_row_loc));
        continue;
      end if;
    end if;

    v_tag    := nullif(btrim(coalesce(v_row ->> 'tag', '')), '');
    v_serial := nullif(btrim(coalesce(v_row ->> 'serial', '')), '');

    -- A tag is generated when the file has none. Most spreadsheets do not have
    -- one, and refusing the import over it would be pedantry: the tag exists
    -- so a label can be printed, and one we generate prints just as well.
    -- ---- how many of this thing -------------------------------------------
    -- One row can be fifty chairs. Each one still becomes its own asset with
    -- its own tag and its own history, which is what lets one of the fifty go
    -- for repair or go missing without the other forty nine being affected.
    -- The register then shows them as a single line with 50 in front of it.
    v_qty := coalesce(
      nullif(regexp_replace(coalesce(v_row ->> 'units', ''), '[^0-9]', '', 'g'), '')::int, 1);
    if v_qty < 1 then v_qty := 1; end if;

    if v_qty > 2000 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'name', v_name,
        'reason', format('%s units on one line looks like a typo. Split it if it is not.', v_qty));
      continue;
    end if;

    -- A serial names one machine and a tag labels one asset, so neither can be
    -- shared by a batch. Caught here so the message names the row and the
    -- field, rather than surfacing as a unique constraint on the second unit.
    if v_qty > 1 and v_serial is not null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'name', v_name, 'serial', v_serial,
        'reason', 'A serial number identifies one machine, so it cannot be shared by '
               || v_qty || ' units. Give this row its own line, or leave the serial blank.');
      continue;
    end if;
    if v_qty > 1 and v_tag is not null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'name', v_name, 'tag', v_tag,
        'reason', 'A tag labels one asset. Leave it blank and each of the '
               || v_qty || ' units is issued its own.');
      continue;
    end if;

    if v_tag is null and not p_commit then
      v_preview_n := v_preview_n + 1;
      v_tag := app.next_asset_tag(p_company);
      -- Walk the preview forward so the sample does not repeat one tag.
      v_tag := regexp_replace(v_tag, '\d+$', '')
               || lpad((coalesce(nullif(regexp_replace(v_tag, '^\D+', '', 'g'), ''), '0')::int
                        + v_preview_n - 1)::text, 5, '0');
    end if;

    -- Only an explicitly given tag can clash, since generated ones are issued
    -- one at a time from the highest already used.
    if v_tag is not null and v_tag = any(v_seen) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'tag', v_tag, 'reason', 'This tag appears twice in the file.');
      continue;
    end if;
    if v_tag is not null then v_seen := v_seen || v_tag; end if;

    if v_serial is not null then
      if v_serial = any(v_seen_sn) then
        v_errors := v_errors || jsonb_build_object(
          'row', v_i, 'tag', v_tag, 'serial', v_serial,
          'reason', 'This serial appears twice in the file.');
        continue;
      end if;
      if exists (select 1 from app.assets
                  where company_id = p_company and serial_no = v_serial) then
        v_errors := v_errors || jsonb_build_object(
          'row', v_i, 'tag', v_tag, 'serial', v_serial,
          'reason', 'An asset with this serial is already on the register.');
        continue;
      end if;
      v_seen_sn := v_seen_sn || v_serial;
    end if;

    -- ---- category and type ------------------------------------------------
    v_cat := null; v_sub := null; v_brand := null; v_model := null;

    if nullif(btrim(coalesce(v_row ->> 'category','')),'') is not null then
      select id into v_cat from app.categories
       where company_id = p_company and lower(name) = lower(btrim(v_row ->> 'category'));
      if v_cat is null and not (lower(btrim(v_row ->> 'category')) = any(v_new_cats)) then
        v_cats := v_cats + 1;
        v_new_cats := v_new_cats || lower(btrim(v_row ->> 'category'));
      end if;
      if v_cat is null then
        if p_commit then
          insert into app.categories (company_id, name)
          values (p_company, btrim(v_row ->> 'category')) returning id into v_cat;
        end if;
      end if;

      -- When the file names no type, the category name is reused rather than
      -- inventing a hierarchy the person did not ask for.
      if v_cat is not null then
        select id into v_sub from app.sub_categories
         where company_id = p_company and category_id = v_cat
           and lower(name) = lower(coalesce(nullif(btrim(coalesce(v_row ->> 'type','')),''),
                                            btrim(v_row ->> 'category')));
        if v_sub is null and p_commit then
          insert into app.sub_categories (company_id, category_id, name)
          values (p_company, v_cat,
                  coalesce(nullif(btrim(coalesce(v_row ->> 'type','')),''),
                           btrim(v_row ->> 'category')))
          returning id into v_sub;
        end if;
      end if;
    end if;

    -- ---- brand ------------------------------------------------------------
    if nullif(btrim(coalesce(v_row ->> 'brand','')),'') is not null then
      select id into v_brand from app.brands
       where company_id = p_company and lower(name) = lower(btrim(v_row ->> 'brand'));
      if v_brand is null and not (lower(btrim(v_row ->> 'brand')) = any(v_new_brands)) then
        v_brands := v_brands + 1;
        v_new_brands := v_new_brands || lower(btrim(v_row ->> 'brand'));
      end if;
      if v_brand is null then
        if p_commit then
          insert into app.brands (company_id, name)
          values (p_company, btrim(v_row ->> 'brand')) returning id into v_brand;
        end if;
      end if;
    end if;

    -- ---- model ------------------------------------------------------------
    if p_commit and v_sub is not null and v_brand is not null
       and nullif(btrim(coalesce(v_row ->> 'model','')),'') is not null then
      select id into v_model from app.models
       where company_id = p_company and brand_id = v_brand
         and lower(name) = lower(btrim(v_row ->> 'model'));
      if v_model is null then
        v_models := v_models + 1;
        insert into app.models (company_id, sub_category_id, brand_id, name)
        values (p_company, v_sub, v_brand, btrim(v_row ->> 'model'))
        returning id into v_model;
      end if;
    elsif not p_commit and nullif(btrim(coalesce(v_row ->> 'model','')),'') is not null then
      declare v_key text := lower(coalesce(btrim(v_row ->> 'brand'),'')) || '|' ||
                            lower(btrim(v_row ->> 'model'));
      begin
        if not exists (
          select 1 from app.models m join app.brands b on b.id = m.brand_id
          where m.company_id = p_company
            and lower(m.name) = lower(btrim(v_row ->> 'model'))
            and lower(b.name) = lower(coalesce(btrim(v_row ->> 'brand'), ''))
        ) and not (v_key = any(v_new_models)) then
          v_models := v_models + 1;
          v_new_models := v_new_models || v_key;
        end if;
      end;
    end if;

    -- ---- the assets, one row at a time ------------------------------------
    if p_commit then
      v_cost := nullif(regexp_replace(coalesce(v_row ->> 'cost',''), '[^0-9]', '', 'g'), '')::bigint;

      for v_n in 1 .. v_qty loop
        insert into app.assets
          (company_id, tag, name, serial_no, model_id, sub_category_id,
           location_id, status, holder, acquired_on)
        values
          (p_company,
           -- Blank for a generated one: the trigger from 0035 fills it, which
           -- keeps the import and the add form on one rule.
           coalesce(v_tag, ''),
           v_name, v_serial, v_model, v_sub, v_use_loc, 'active',
           nullif(btrim(coalesce(v_row ->> 'holder','')),''),
           case when (v_row ->> 'acquired') ~ '^\d{4}-\d{2}-\d{2}$'
                then (v_row ->> 'acquired')::date else null end)
        returning id into v_asset;

        -- The cost column is the cost of ONE, written against each unit. Ten
        -- chairs on a 450,000 invoice are 45,000 each; storing the total ten
        -- times would overstate the estate tenfold, and depreciation, book
        -- value and disposal are all worked out per asset.
        if v_cost is not null then
          insert into app.asset_financials (asset_id, company_id, purchase_cost_minor)
          values (v_asset, p_company, v_cost * 100);
        end if;
      end loop;
    end if;

    v_created := v_created + v_qty;
  end loop;

  if p_commit then
    perform app.log(p_company, 'imported assets', 'assets', null::text,
      btrim(p_location_name),
      format('%s asset(s) at %s, %s rejected', v_created, btrim(p_location_name),
             jsonb_array_length(v_errors)),
      (case when jsonb_array_length(v_errors) > 0 then 'warn' else 'ok' end)::app.audit_tone,
      v_loc);
  end if;

  return jsonb_build_object(
    'committed', p_commit,
    'location', btrim(p_location_name),
    'location_is_new', v_new_loc,
    'locations_created', v_locs,
    'assets', v_created,
    'models', v_models,
    'categories', v_cats,
    'brands', v_brands,
    'rejected', jsonb_array_length(v_errors),
    'errors', v_errors);
end $$;

revoke all on function app.import_branch(uuid, text, jsonb, boolean, uuid, text) from public;
grant execute on function app.import_branch(uuid, text, jsonb, boolean, uuid, text) to authenticated;
