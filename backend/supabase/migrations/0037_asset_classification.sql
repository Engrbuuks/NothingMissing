-- ============================================================================
-- 0037_asset_classification.sql
-- Category and type for assets that have no catalog model.
--
-- An asset has always had a category and a type. It reached them through the
-- catalog: asset → model → sub_category (the type) → category. That is the
-- right shape when a model exists, because the classification is part of the
-- description and belongs written once.
--
-- It stops working the moment a model does not exist, and there are now two
-- ordinary ways to arrive there:
--
--   1. The add-asset form. A model is optional — deliberately, because
--      demanding a full catalog entry before a chair can be recorded is how a
--      register never gets built. Every asset added that way is uncategorised.
--
--   2. The spreadsheet import, and this one is worse because it looks like it
--      worked. `import_branch()` only builds a model when the file names a
--      type AND a brand. A file with a Category column and no Brand column
--      creates the category, creates the type, and then attaches the asset to
--      neither — so the category appears in the catalog, the asset reads
--      "Uncategorised", and nothing reports a problem. Verified before fixing:
--      one row naming Furniture produced the Furniture category and an asset
--      with model_id null and no category at all.
--
-- The fix is a type on the asset itself, used only when there is no model.
--
-- WHY NOT BOTH AT ONCE. Two columns that can each answer "what kind of thing
-- is this" is two sources of truth, and they drift: somebody sets the asset to
-- Furniture, later attaches an IT model, and the register now disagrees with
-- itself with nothing on screen saying so. So the rule is that THE MODEL WINS,
-- enforced by trigger — attaching a model clears the asset's own type. Exactly
-- one of the two is ever set, which makes resolution a coalesce with no
-- ambiguity to reason about.
--
-- This is the same three-level idea 0022 used for specifications, with the
-- levels ordered the other way: there, an asset override beats the model,
-- because "this unit has 16GB" is a fact about one machine. Here the model
-- beats the asset, because "this is a computer" is a fact about the kind, and
-- a unit that disagrees with its own model about what it is, is a mistake
-- rather than an override.
-- ============================================================================

alter table app.assets
  add column if not exists sub_category_id uuid
    references app.sub_categories(id) on delete set null;

comment on column app.assets.sub_category_id is
  'The type of this asset when it has no catalog model. Always null while '
  'model_id is set — the model carries the classification then, and the '
  'trigger below enforces that so the two can never disagree.';

-- Filtering the register by category walks this, so it needs an index for the
-- same reason models_sub_category_idx exists.
create index if not exists assets_sub_category_idx
  on app.assets (company_id, sub_category_id)
  where sub_category_id is not null;

-- ================================================================== guard ====
create or replace function app.assets_one_classification()
returns trigger
language plpgsql set search_path = app, extensions, public, pg_temp as $$
begin
  -- The model carries the classification whenever there is one. Clearing the
  -- asset's own type rather than refusing the update means attaching a model
  -- to a roughly-classified asset just works, which is the normal direction of
  -- travel: things get catalogued after they are recorded, not before.
  if new.model_id is not null then
    new.sub_category_id := null;
  end if;
  return new;
end $$;

drop trigger if exists assets_one_classification_trg on app.assets;
create trigger assets_one_classification_trg
  before insert or update on app.assets
  for each row execute function app.assets_one_classification();

-- Anything already carrying both, from a row written before this trigger.
update app.assets set sub_category_id = null
 where model_id is not null and sub_category_id is not null;

-- ============================================================== resolution ===
-- One answer to "what kind of thing is this", so no caller has to remember the
-- precedence. A view rather than a function: PostgREST can select from it and
-- filter on it, which a function returning a row per asset cannot do well.
--
-- `security_invoker = true` is load-bearing, not decoration. A view runs as
-- its OWNER by default, which means it reads app.assets with the owner's
-- rights and row-level security on that table does not apply to the caller —
-- so a plain view here would have handed every authenticated user every
-- company's classifications. The standing RLS guard in scripts/verify_rls.sql
-- caught this, which is exactly what it is for.
create or replace view app.asset_classification
  with (security_invoker = true) as
  select
    a.id            as asset_id,
    a.company_id,
    coalesce(msc.id,  asc_.id)  as sub_category_id,
    coalesce(msc.name, asc_.name) as type_name,
    coalesce(mc.id,   ac.id)    as category_id,
    coalesce(mc.name,  ac.name)   as category_name,
    -- Where the answer came from, because "Uncategorised" and "classified by
    -- hand" and "inherited from the catalog" are three different situations
    -- and a screen that shows them identically hides work that needs doing.
    case
      when msc.id is not null then 'model'
      when asc_.id is not null then 'asset'
      else 'none'
    end as classified_by
  from app.assets a
  left join app.models         m    on m.id    = a.model_id
  left join app.sub_categories msc  on msc.id  = m.sub_category_id
  left join app.categories     mc   on mc.id   = msc.category_id
  left join app.sub_categories asc_ on asc_.id = a.sub_category_id
  left join app.categories     ac   on ac.id   = asc_.category_id;

-- No policies of its own, and none possible: a view cannot carry RLS. It is
-- safe only because security_invoker makes it read app.assets as the caller,
-- so a rival company sees no rows here for the same reason it sees no assets.
-- That is asserted in the test suite rather than assumed.
grant select on app.asset_classification to authenticated;

-- ====================================================== classifying by hand ==
-- Set or clear the type of an asset that has no catalog model.
create or replace function app.classify_asset(
  p_asset        uuid,
  p_sub_category uuid
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_a app.assets%rowtype;
  v_s app.sub_categories%rowtype;
  v_label text;
begin
  select * into v_a from app.assets where id = p_asset;
  if not found then
    raise exception 'asset not found' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if v_a.model_id is not null then
    raise exception 'that asset is catalogued as a model, which carries its type'
      using errcode = 'check_violation',
            hint = 'Change the model, or the type on the model itself.';
  end if;

  if p_sub_category is null then
    update app.assets set sub_category_id = null where id = p_asset;
    perform app.log(v_a.company_id, 'classified an asset', 'assets',
      p_asset::text, v_a.tag, 'type cleared', 'info', v_a.location_id);
    return;
  end if;

  select * into v_s from app.sub_categories where id = p_sub_category;
  if not found or v_s.company_id <> v_a.company_id then
    raise exception 'that type belongs to another company' using errcode = '42501';
  end if;

  update app.assets set sub_category_id = p_sub_category where id = p_asset;

  select c.name || ' → ' || v_s.name into v_label
    from app.categories c where c.id = v_s.category_id;

  perform app.log(v_a.company_id, 'classified an asset', 'assets',
    p_asset::text, v_a.tag, 'type set to ' || coalesce(v_label, v_s.name),
    'info', v_a.location_id);
end $$;

revoke all on function app.classify_asset(uuid, uuid) from public;
grant execute on function app.classify_asset(uuid, uuid) to authenticated;

-- ======================================================= what needs tidying ==
-- Assets with no classification at all, grouped so somebody can fix a whole
-- batch rather than hunting one at a time.
create or replace function app.unclassified_assets(p_company uuid)
returns table (name text, units bigint, location text, sample_tag text)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select a.name,
         count(*)                    as units,
         coalesce(l.name, 'in transit') as location,
         min(a.tag)                  as sample_tag
    from app.assets a
    left join app.locations l on l.id = a.location_id
   where a.company_id = p_company
     and app.is_member(p_company)
     and a.status <> 'retired'
     and a.model_id is null
     and a.sub_category_id is null
   group by a.name, l.name
   order by count(*) desc, a.name
$$;

revoke all on function app.unclassified_assets(uuid) from public;
grant execute on function app.unclassified_assets(uuid) to authenticated;

-- ============================================== the import bug, at its root ==
-- `import_branch()` resolved a category and a type from the file and then
-- attached the asset to neither unless a brand was also present. The category
-- was created, so the import looked like it had worked.
--
-- Only the asset insert changes: where a model was built, nothing is different
-- (the trigger clears the asset's own type anyway); where one could not be,
-- the type now lands on the asset instead of being discarded.
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
      -- v_sub is the type resolved from the file's Category column. It was
      -- previously discarded whenever no model could be built (which needs a
      -- brand as well), so a file naming a category created that category and
      -- left every asset in it uncategorised. The trigger clears this again
      -- when v_model is not null, so the model still wins where there is one.
      insert into app.assets
        (company_id, tag, name, serial_no, model_id, sub_category_id,
         location_id, status, holder, acquired_on)
      values
        (p_company, v_tag, v_name, v_serial, v_model, v_sub, v_loc, 'active',
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
