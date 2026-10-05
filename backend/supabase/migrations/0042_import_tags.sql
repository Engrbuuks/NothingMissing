-- ============================================================================
-- 0042_import_tags.sql
-- The spreadsheet import issues tags the same way the form does.
--
-- 0035 replaced the tag generator for assets added through the form, with a
-- trigger calling app.next_asset_tag(). It reads the highest number actually
-- issued, and prefixes with the company's own initials.
--
-- The import never went through it. import_branch() passes an explicit tag, so
-- the trigger's "fill it if blank" branch never fires, and the old generator
-- stayed in place:
--
--     'NM-' || lpad(((select count(*) from app.assets ...) + v_i), 5, '0')
--
-- Two things wrong with that, both visible on a real import:
--
-- 1. THE WRONG PREFIX. A company whose assets read ZEN-00001 from the form got
--    NM-00009 from a spreadsheet. One register, two numbering schemes, and the
--    NM is ours rather than theirs.
--
-- 2. COUNTING IS NOT NUMBERING. count(*) rises as the loop inserts, so the
--    offset double counts and the file produces 9, 11, 13 rather than 9, 10,
--    11. Worse, a count falls when something is deleted, so freed numbers come
--    back around: a later import was observed taking NM-00010 and NM-00012,
--    numbers that had belonged to deleted assets. A gap is untidy. Reissuing a
--    number is a label on a shelf that now names a different object, which is
--    exactly the kind of quiet wrongness a register exists to prevent.
--
-- next_asset_tag() reads max(), not count(), so a deleted number is retired
-- rather than recycled. Nothing else in import_branch() changes: a tag given
-- in the file is still respected, and a row without one still imports.
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

    v_tag    := nullif(btrim(coalesce(v_row ->> 'tag', '')), '');
    v_serial := nullif(btrim(coalesce(v_row ->> 'serial', '')), '');

    -- A tag is generated when the file has none. Most spreadsheets do not have
    -- one, and refusing the import over it would be pedantry: the tag exists
    -- so a label can be printed, and one we generate prints just as well.
    if v_tag is null then
      if p_commit then
        v_tag := app.next_asset_tag(p_company);
      else
        v_preview_n := v_preview_n + 1;
        v_tag := app.next_asset_tag(p_company);
        -- Walk the preview forward so the sample does not repeat one tag.
        v_tag := regexp_replace(v_tag, '\d+$', '')
                 || lpad((coalesce(nullif(regexp_replace(v_tag, '^\D+', '', 'g'), ''), '0')::int
                          + v_preview_n - 1)::text, 5, '0');
      end if;
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

    -- ---- the asset --------------------------------------------------------
    if p_commit then
      insert into app.assets
        (company_id, tag, name, serial_no, model_id, sub_category_id,
         location_id, status, holder, acquired_on)
      values
        (p_company, v_tag, v_name, v_serial, v_model, v_sub, v_loc, 'active',
         nullif(btrim(coalesce(v_row ->> 'holder','')),''),
         case when (v_row ->> 'acquired') ~ '^\d{4}-\d{2}-\d{2}$'
              then (v_row ->> 'acquired')::date else null end)
      returning id into v_asset;

      v_cost := nullif(regexp_replace(coalesce(v_row ->> 'cost',''), '[^0-9]', '', 'g'), '')::bigint;
      if v_cost is not null then
        insert into app.asset_financials (asset_id, company_id, purchase_cost_minor)
        values (v_asset, p_company, v_cost * 100);
      end if;
    end if;

    v_created := v_created + 1;
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
    'assets', v_created,
    'models', v_models,
    'categories', v_cats,
    'brands', v_brands,
    'rejected', jsonb_array_length(v_errors),
    'errors', v_errors);
end $$;

revoke all on function app.import_branch(uuid, text, jsonb, boolean, uuid, text) from public;
grant execute on function app.import_branch(uuid, text, jsonb, boolean, uuid, text) to authenticated;
