-- ============================================================================
-- 0024_branch_import.sql
-- Getting a branch onto the register in one go.
--
-- The problem: adding a branch's assets meant creating a location, then
-- categories, then types, then brands, then models — five screens of setup
-- before a single asset could be entered. Nobody does that. They give up, or
-- they enter everything as uncategorised text and the catalog stays empty,
-- which loses the thing that made it worth having.
--
-- So this takes a spreadsheet with the columns people actually have, and
-- builds everything underneath it:
--
--   * the location, if it does not exist
--   * categories, types and brands named in the file
--   * a catalog model per distinct make-and-model
--   * the assets themselves, linked to all of it
--
-- Two decisions worth stating.
--
-- ONE TRANSACTION. A duplicate tag or serial anywhere rejects the entire file.
-- A half-imported register is worse than no register: you cannot tell which
-- rows are real without re-reading the spreadsheet line by line, and people
-- trust what they see on screen.
--
-- DRY RUN FIRST. The same function with p_commit false reports exactly what it
-- would create and what it would reject, changing nothing. Importing 400 rows
-- and discovering afterwards that a column was misread is how somebody ends up
-- with 400 assets called "Qty".
-- ============================================================================

create or replace function app.import_branch(
  p_company      uuid,
  p_location_name text,
  p_rows         jsonb,          -- [{tag,name,serial,category,type,brand,model,holder,acquired,cost,notes}, …]
  p_commit       boolean default false,
  p_location_id  uuid default null,
  p_city         text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_loc      uuid := p_location_id;
  v_row      jsonb;
  v_tag      text;
  v_name     text;
  v_serial   text;
  v_cat      uuid;
  v_sub      uuid;
  v_brand    uuid;
  v_model    uuid;
  v_created  int := 0;
  v_models   int := 0;
  v_cats     int := 0;
  v_brands   int := 0;
  v_errors   jsonb := '[]'::jsonb;
  v_seen     text[] := '{}';
  v_seen_sn  text[] := '{}';
  -- A dry run cannot deduplicate by querying, because it writes nothing. So it
  -- remembers what it has already counted — otherwise the preview reports six
  -- new brands for a file naming two, and the number somebody sanity-checks
  -- against is wrong in exactly the direction that erodes trust.
  v_new_cats   text[] := '{}';
  v_new_brands text[] := '{}';
  v_new_models text[] := '{}';
  v_i        int := 0;
  v_new_loc  boolean := false;
  v_cost     bigint;
begin
  if not app.has_role(p_company, 'owner', 'admin', 'manager') then
    raise exception 'You do not have permission to import here.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to import.' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'That is more than 5,000 rows. Split it into a few files.'
      using errcode = 'check_violation',
            hint = 'One transaction that large will time out, and a timeout mid-import is exactly the half-finished state this avoids.';
  end if;

  -- ---- the location ------------------------------------------------------
  if v_loc is null then
    select id into v_loc from app.locations
     where company_id = p_company and lower(name) = lower(btrim(p_location_name))
       and archived_at is null;

    if v_loc is null then
      if length(btrim(coalesce(p_location_name, ''))) < 2 then
        raise exception 'Give the branch a name.' using errcode = 'check_violation';
      end if;
      v_new_loc := true;
      if p_commit then
        insert into app.locations (company_id, name, kind, city)
        values (p_company, btrim(p_location_name), 'physical', nullif(btrim(coalesce(p_city,'')),''))
        returning id into v_loc;
      end if;
    end if;
  end if;

  -- ---- the rows ----------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_i := v_i + 1;
    v_tag    := nullif(btrim(coalesce(v_row ->> 'tag', '')), '');
    v_name   := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    v_serial := nullif(btrim(coalesce(v_row ->> 'serial', '')), '');

    if v_name is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'reason', 'No name — every asset needs one.');
      continue;
    end if;

    -- A tag is generated when the file has none. Most spreadsheets do not have
    -- one, and refusing the import over it would be pedantry: the tag exists
    -- so a label can be printed, and one we generate prints just as well.
    if v_tag is null then
      v_tag := 'NM-' || lpad(((
        select count(*) from app.assets where company_id = p_company
      ) + v_i)::text, 5, '0');
    end if;

    if v_tag = any(v_seen) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'tag', v_tag, 'reason', 'This tag appears twice in the file.');
      continue;
    end if;
    v_seen := v_seen || v_tag;

    if v_serial is not null then
      if v_serial = any(v_seen_sn) then
        v_errors := v_errors || jsonb_build_object(
          'row', v_i, 'tag', v_tag, 'serial', v_serial,
          'reason', 'This serial appears twice in the file.');
        continue;
      end if;
      v_seen_sn := v_seen_sn || v_serial;

      if exists (select 1 from app.assets
                 where company_id = p_company and serial_no = v_serial) then
        v_errors := v_errors || jsonb_build_object(
          'row', v_i, 'tag', v_tag, 'serial', v_serial,
          'reason', 'This serial is already on the register.');
        continue;
      end if;
    end if;

    if exists (select 1 from app.assets where company_id = p_company and tag = v_tag) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_i, 'tag', v_tag, 'reason', 'This tag is already on the register.');
      continue;
    end if;

    -- ---- the catalog, built from what the file says ----------------------
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

      -- A type is required to hang a model on. If the file does not name one,
      -- the category name is reused rather than inventing a hierarchy the
      -- customer did not ask for.
      if p_commit and v_cat is not null then
        select id into v_sub from app.sub_categories
         where company_id = p_company and category_id = v_cat
           and lower(name) = lower(coalesce(nullif(btrim(coalesce(v_row ->> 'type','')),''),
                                            btrim(v_row ->> 'category')));
        if v_sub is null then
          insert into app.sub_categories (company_id, category_id, name)
          values (p_company, v_cat,
                  coalesce(nullif(btrim(coalesce(v_row ->> 'type','')),''),
                           btrim(v_row ->> 'category')))
          returning id into v_sub;
        end if;
      end if;
    end if;

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

    -- One model per distinct make and model, so forty identical machines
    -- share one catalog row rather than creating forty.
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

    -- ---- the asset -------------------------------------------------------
    if p_commit then
      insert into app.assets
        (company_id, tag, name, serial_no, model_id, location_id, status, holder, acquired_on)
      values
        (p_company, v_tag, v_name, v_serial, v_model, v_loc, 'active',
         nullif(btrim(coalesce(v_row ->> 'holder','')),''),
         case when (v_row ->> 'acquired') ~ '^\d{4}-\d{2}-\d{2}$'
              then (v_row ->> 'acquired')::date else null end);

      v_cost := nullif(regexp_replace(coalesce(v_row ->> 'cost',''), '[^0-9]', '', 'g'), '')::bigint;
      if v_cost is not null and v_cost > 0 then
        insert into app.asset_financials (asset_id, company_id, purchase_cost_minor)
        select id, p_company, v_cost * 100 from app.assets
         where company_id = p_company and tag = v_tag;
      end if;
    end if;

    v_created := v_created + 1;
  end loop;

  if p_commit then
    perform app.log(p_company,
      case when v_new_loc then 'imported a new branch' else 'imported assets' end,
      'assets', v_loc::text, btrim(p_location_name),
      format('%s assets, %s models, %s categories', v_created, v_models, v_cats),
      'ok', v_loc);
  end if;

  return jsonb_build_object(
    'committed', p_commit,
    'location', btrim(p_location_name),
    'location_is_new', v_new_loc,
    'assets', v_created,
    'models', v_models,
    'categories', v_cats,
    'brands', v_brands,
    'rejected', jsonb_array_length(v_errors),
    'errors', v_errors);
end $$;

grant execute on function app.import_branch(uuid, text, jsonb, boolean, uuid, text) to authenticated;
