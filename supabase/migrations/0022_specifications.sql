-- ============================================================================
-- 0022_specifications.sql
-- Describing things properly.
--
-- The problem this solves: `models.specs` was a freeform jsonb array, so one
-- person typed "24 inch", another "24\"", a third "610mm". Nobody could filter
-- on it, nobody could total it, and in practice nobody filled it in — because
-- an empty box with no label is an invitation to skip.
--
-- The fix is attributes defined per category, once, by the company. A CHAIR has
-- upholstery, armrests and a weight limit. A COMPUTER has processor, memory and
-- screen size. A DESK has width, depth and material. The form for a new model
-- is then generated from the category, which means it is short, obviously
-- relevant, and answerable — and every answer is comparable across models
-- because it went into the same typed field.
--
-- Three levels, and the distinction matters:
--
--   CATEGORY attributes  — what any thing of this kind has
--   MODEL values         — what THIS kind of thing has (all units share it)
--   ASSET overrides      — what is true of this ONE unit and nothing else
--
-- The third exists because reality does not respect the catalog: one
-- IdeaCentre had its memory upgraded to 16GB, one chair was reupholstered in
-- a different fabric. Without overrides somebody edits the model and silently
-- changes the description of forty other machines.
-- ============================================================================

do $$ begin
  create type app.attr_kind as enum
    ('text','number','choice','boolean','dimension','colour');
exception when duplicate_object then null; end $$;

create table if not exists app.attributes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  -- Attached to a category, so a chair never asks for a processor. Null means
  -- it applies to everything the company owns — an asset tag colour, say.
  category_id   uuid references app.categories(id) on delete cascade,
  code          text not null,
  label         text not null,
  kind          app.attr_kind not null default 'text',
  unit          text,                       -- 'mm', 'kg', 'GB', '"'
  choices       text[] not null default '{}',
  required      boolean not null default false,
  -- Shown on the register and in filters, rather than only on the detail page.
  filterable    boolean not null default false,
  sort_order    int not null default 100,
  help          text,
  created_at    timestamptz not null default now(),
  unique (company_id, category_id, code),
  -- A choice attribute with no choices is a text box wearing a costume, and
  -- the whole point is that answers are comparable.
  constraint choice_needs_options check (kind <> 'choice' or array_length(choices, 1) >= 2)
);

create index if not exists attributes_cat_idx on app.attributes (company_id, category_id, sort_order);

alter table app.attributes enable row level security;
alter table app.attributes force row level security;

drop policy if exists attributes_select on app.attributes;
create policy attributes_select on app.attributes
  for select using ( app.is_member(company_id) );

drop policy if exists attributes_write on app.attributes;
create policy attributes_write on app.attributes
  for all
  using      ( app.has_role(company_id, 'owner','admin','manager') )
  with check ( app.has_role(company_id, 'owner','admin','manager') );

-- ------------------------------------------------------- values on models --
-- One row per attribute per model. A table rather than a jsonb blob so a value
-- can be indexed, filtered and typed — "every AIO with 16GB or more" is a
-- query here and a full scan of parsed JSON otherwise.
create table if not exists app.model_attributes (
  model_id      uuid not null references app.models(id) on delete cascade,
  attribute_id  uuid not null references app.attributes(id) on delete cascade,
  company_id    uuid not null references app.companies(id) on delete cascade,
  value_text    text,
  value_number  numeric(14,3),
  value_bool    boolean,
  primary key (model_id, attribute_id)
);

create index if not exists model_attrs_lookup on app.model_attributes (attribute_id, value_text);
create index if not exists model_attrs_number on app.model_attributes (attribute_id, value_number);

alter table app.model_attributes enable row level security;
alter table app.model_attributes force row level security;

drop policy if exists model_attrs_select on app.model_attributes;
create policy model_attrs_select on app.model_attributes
  for select using ( app.is_member(company_id) );

drop policy if exists model_attrs_write on app.model_attributes;
create policy model_attrs_write on app.model_attributes
  for all
  using      ( app.has_role(company_id, 'owner','admin','manager') )
  with check ( app.has_role(company_id, 'owner','admin','manager') );

-- ---------------------------------------------------- overrides on assets --
-- What is true of this one unit and not of its model. Deliberately the same
-- shape, so the resolver can union them without special cases.
create table if not exists app.asset_attributes (
  asset_id      uuid not null references app.assets(id) on delete cascade,
  attribute_id  uuid not null references app.attributes(id) on delete cascade,
  company_id    uuid not null references app.companies(id) on delete cascade,
  value_text    text,
  value_number  numeric(14,3),
  value_bool    boolean,
  note          text,          -- 'upgraded March 2026'
  primary key (asset_id, attribute_id)
);

alter table app.asset_attributes enable row level security;
alter table app.asset_attributes force row level security;

drop policy if exists asset_attrs_select on app.asset_attributes;
create policy asset_attrs_select on app.asset_attributes
  for select using ( app.is_member(company_id) );

drop policy if exists asset_attrs_write on app.asset_attributes;
create policy asset_attrs_write on app.asset_attributes
  for all
  using      ( app.can_write(company_id) )
  with check ( app.can_write(company_id) );

-- 8 GB should read "8 GB", not "8.000 GB". numeric(14,3) keeps the scale for
-- values that need it (1.5 metres) and this drops it for the ones that do not.
create or replace function app.fmt_number(p numeric)
returns text language sql immutable as $$
  select case when p is null then null
              when p = trunc(p) then trim(to_char(p, 'FM999999999999'))
              else trim(to_char(p, 'FM999999999999.999')) end
$$;

-- ========================================================== resolving ======
-- The description of one asset: its model's values, with its own overrides
-- winning. This is what the detail page shows and what an export prints.
create or replace function app.asset_specification(p_asset uuid)
returns table (
  code text, label text, kind app.attr_kind, unit text,
  value text, source text, note text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  with a as (
    select id, company_id, model_id from app.assets where id = p_asset
  ),
  defined as (
    select at.* from a cross join app.attributes at
    where at.company_id = a.company_id
      and (at.category_id is null or at.category_id = (
        select sc.category_id from app.models m
        join app.sub_categories sc on sc.id = m.sub_category_id
        where m.id = a.model_id))
  )
  select
    d.code, d.label, d.kind, d.unit,
    -- The unit's own value if it has one, otherwise the model's.
    coalesce(
      aa.value_text, ma.value_text,
      app.fmt_number(coalesce(aa.value_number, ma.value_number)),
      case coalesce(aa.value_bool, ma.value_bool)
        when true then 'Yes' when false then 'No' else null end
    ) as value,
    case
      when aa.attribute_id is not null then 'this unit'
      when ma.attribute_id is not null then 'model'
      else 'not recorded' end as source,
    aa.note
  from defined d
  left join app.model_attributes ma
    on ma.attribute_id = d.id and ma.model_id = (select model_id from a)
  left join app.asset_attributes aa
    on aa.attribute_id = d.id and aa.asset_id = p_asset
  where app.is_member((select company_id from a))
  order by d.sort_order, d.label
$$;

grant execute on function app.asset_specification(uuid) to authenticated;

create or replace function app.model_specification(p_model uuid)
returns table (
  attribute_id uuid, code text, label text, kind app.attr_kind, unit text,
  choices text[], required boolean, value text, help text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  with m as (
    select mo.id, mo.company_id, sc.category_id
    from app.models mo
    join app.sub_categories sc on sc.id = mo.sub_category_id
    where mo.id = p_model
  )
  -- CROSS JOIN rather than a comma, so `m` is in scope for the LEFT JOIN that
  -- follows. A comma-join binds tighter and leaves d unreachable from it.
  select
    d.id, d.code, d.label, d.kind, d.unit, d.choices, d.required,
    coalesce(ma.value_text,
             app.fmt_number(ma.value_number),
             case ma.value_bool when true then 'Yes' when false then 'No' else null end),
    d.help
  from m
  cross join app.attributes d
  left join app.model_attributes ma
    on ma.attribute_id = d.id and ma.model_id = m.id
  where d.company_id = m.company_id
    and (d.category_id is null or d.category_id = m.category_id)
    and app.is_member(m.company_id)
  order by d.sort_order, d.label
$$;

grant execute on function app.model_specification(uuid) to authenticated;

-- The blank form for a new model in a category: what to ask, and how.
create or replace function app.category_attributes(p_category uuid)
returns table (
  id uuid, code text, label text, kind app.attr_kind, unit text,
  choices text[], required boolean, help text, sort_order int
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select a.id, a.code, a.label, a.kind, a.unit, a.choices, a.required, a.help, a.sort_order
  from app.attributes a
  join app.categories c on c.id = p_category
  where a.company_id = c.company_id
    and (a.category_id is null or a.category_id = p_category)
    and app.is_member(c.company_id)
  order by a.sort_order, a.label
$$;

grant execute on function app.category_attributes(uuid) to authenticated;

-- ---------------------------------------------------------- writing -------
-- One call sets every attribute for a model, because a form submits all of
-- them at once and doing it row by row means a half-saved specification if
-- anything fails in the middle.
create or replace function app.set_model_attributes(p_model uuid, p_values jsonb)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid;
  v_key text;
  v_raw text;
  v_attr app.attributes%rowtype;
begin
  select company_id into v_company from app.models where id = p_model;
  if v_company is null then
    raise exception 'No such model.' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_company, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  for v_key, v_raw in select key, value #>> '{}' from jsonb_each(p_values) loop
    select * into v_attr from app.attributes
     where company_id = v_company and code = v_key
       and (category_id is null or category_id = (
         select sc.category_id from app.models m
         join app.sub_categories sc on sc.id = m.sub_category_id
         where m.id = p_model));

    continue when not found;

    if v_raw is null or btrim(v_raw) = '' then
      delete from app.model_attributes
       where model_id = p_model and attribute_id = v_attr.id;
      continue;
    end if;

    -- A choice outside its list is rejected rather than stored, because the
    -- entire value of a choice field is that the answers are comparable.
    if v_attr.kind = 'choice' and not (v_raw = any(v_attr.choices)) then
      raise exception '% is not one of the options for %', v_raw, v_attr.label
        using errcode = 'check_violation';
    end if;

    if v_attr.kind in ('number','dimension') and v_raw !~ '^-?[0-9]+(\.[0-9]+)?$' then
      raise exception '% must be a number', v_attr.label using errcode = 'check_violation';
    end if;

    insert into app.model_attributes
      (model_id, attribute_id, company_id, value_text, value_number, value_bool)
    values (
      p_model, v_attr.id, v_company,
      case when v_attr.kind in ('number','dimension','boolean') then null else v_raw end,
      case when v_attr.kind in ('number','dimension') then v_raw::numeric else null end,
      case when v_attr.kind = 'boolean' then v_raw in ('true','yes','on','1') else null end)
    on conflict (model_id, attribute_id) do update
      set value_text = excluded.value_text,
          value_number = excluded.value_number,
          value_bool = excluded.value_bool;
  end loop;

  perform app.log(v_company, 'updated a specification', 'models', p_model::text,
    (select name from app.models where id = p_model), null, 'info');
end $$;

grant execute on function app.set_model_attributes(uuid, jsonb) to authenticated;

create or replace function app.set_asset_attribute(
  p_asset uuid, p_code text, p_value text, p_note text default null
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_company uuid; v_attr app.attributes%rowtype;
begin
  select company_id into v_company from app.assets where id = p_asset;
  if v_company is null then
    raise exception 'No such asset.' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_company) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select * into v_attr from app.attributes
   where company_id = v_company and code = p_code limit 1;
  if not found then
    raise exception 'There is no attribute called %.', p_code using errcode = 'no_data_found';
  end if;

  if p_value is null or btrim(p_value) = '' then
    delete from app.asset_attributes where asset_id = p_asset and attribute_id = v_attr.id;
    return;
  end if;

  if v_attr.kind = 'choice' and not (p_value = any(v_attr.choices)) then
    raise exception '% is not one of the options for %', p_value, v_attr.label
      using errcode = 'check_violation';
  end if;

  insert into app.asset_attributes
    (asset_id, attribute_id, company_id, value_text, value_number, value_bool, note)
  values (
    p_asset, v_attr.id, v_company,
    case when v_attr.kind in ('number','dimension','boolean') then null else p_value end,
    case when v_attr.kind in ('number','dimension') then p_value::numeric else null end,
    case when v_attr.kind = 'boolean' then p_value in ('true','yes','on','1') else null end,
    p_note)
  on conflict (asset_id, attribute_id) do update
    set value_text = excluded.value_text, value_number = excluded.value_number,
        value_bool = excluded.value_bool, note = excluded.note;

  perform app.log(v_company, 'recorded a difference on one unit', 'assets', p_asset::text,
    (select tag from app.assets where id = p_asset),
    format('%s: %s%s', v_attr.label, p_value, coalesce(' — ' || p_note, '')), 'info');
end $$;

grant execute on function app.set_asset_attribute(uuid, text, text, text) to authenticated;

-- ------------------------------------------------- attribute management ----
create or replace function app.upsert_attribute(
  p_company uuid, p_category uuid, p_code text, p_label text,
  p_kind app.attr_kind, p_unit text default null,
  p_choices text[] default '{}', p_required boolean default false,
  p_filterable boolean default false, p_help text default null,
  p_sort int default 100
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_id uuid; v_code text;
begin
  if not app.has_role(p_company, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  v_code := lower(regexp_replace(btrim(coalesce(nullif(p_code,''), p_label)), '[^a-zA-Z0-9]+', '_', 'g'));
  v_code := btrim(v_code, '_');
  if v_code = '' then
    raise exception 'Give the attribute a name.' using errcode = 'check_violation';
  end if;

  insert into app.attributes
    (company_id, category_id, code, label, kind, unit, choices, required, filterable, help, sort_order)
  values (p_company, p_category, v_code, btrim(p_label), p_kind, nullif(btrim(coalesce(p_unit,'')),''),
          coalesce(p_choices,'{}'), p_required, p_filterable, nullif(btrim(coalesce(p_help,'')),''), p_sort)
  on conflict (company_id, category_id, code) do update
    set label = excluded.label, kind = excluded.kind, unit = excluded.unit,
        choices = excluded.choices, required = excluded.required,
        filterable = excluded.filterable, help = excluded.help, sort_order = excluded.sort_order
  returning id into v_id;

  return v_id;
end $$;

grant execute on function app.upsert_attribute(uuid, uuid, text, text, app.attr_kind, text, text[], boolean, boolean, text, int) to authenticated;

create or replace function app.delete_attribute(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_a app.attributes%rowtype; v_n int;
begin
  select * into v_a from app.attributes where id = p_id;
  if not found then raise exception 'No such attribute.' using errcode='no_data_found'; end if;
  if not app.has_role(v_a.company_id, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select count(*) into v_n from app.model_attributes where attribute_id = p_id;
  if v_n > 0 then
    raise exception '% models have a value recorded for this.', v_n
      using errcode = 'check_violation',
            hint = 'Deleting it would throw those answers away. Clear them first if you are sure.';
  end if;

  delete from app.attributes where id = p_id;
  return jsonb_build_object('deleted', true, 'label', v_a.label);
end $$;

grant execute on function app.delete_attribute(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A starter set, so a new company is not staring at an empty screen wondering
-- what an attribute is. Created only for categories a company actually has,
-- and only if they have defined none of their own.
-- ---------------------------------------------------------------------------
create or replace function app.seed_attributes(p_company uuid)
returns int
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_cat uuid; v_n int := 0; v_name text;
begin
  if not app.has_role(p_company, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if exists (select 1 from app.attributes where company_id = p_company) then
    return 0;   -- never overwrite what somebody has already set up
  end if;

  for v_cat, v_name in
    select id, lower(name) from app.categories where company_id = p_company
  loop
    -- Word-boundary anchored. An earlier version used 'it' unanchored, which
    -- matched "furniture" and asked chairs for a processor.
    if v_name ~ '(comput|electron|technolog|\mit\M|\mict\M|hardware)' then
      perform app.upsert_attribute(p_company, v_cat, 'processor', 'Processor', 'text', null, '{}', false, true, 'e.g. Intel i5-1235U', 10);
      perform app.upsert_attribute(p_company, v_cat, 'memory_gb', 'Memory', 'number', 'GB', '{}', false, true, null, 20);
      perform app.upsert_attribute(p_company, v_cat, 'storage_gb', 'Storage', 'number', 'GB', '{}', false, true, null, 30);
      perform app.upsert_attribute(p_company, v_cat, 'storage_type', 'Storage type', 'choice', null,
        array['SSD','HDD','Hybrid'], false, true, null, 40);
      perform app.upsert_attribute(p_company, v_cat, 'screen_inches', 'Screen size', 'number', 'in', '{}', false, true, null, 50);
      perform app.upsert_attribute(p_company, v_cat, 'form_factor', 'Form factor', 'choice', null,
        array['All-in-one','Desktop tower','Laptop','Mini PC','Monitor'], false, true, null, 60);
      perform app.upsert_attribute(p_company, v_cat, 'operating_system', 'Operating system', 'text', null, '{}', false, false, null, 70);
      v_n := v_n + 7;

    elsif v_name ~ '(furnit|chair|desk|table|seating|fitting)' then
      perform app.upsert_attribute(p_company, v_cat, 'item_type', 'Type', 'choice', null,
        array['Task chair','Executive chair','Visitor chair','Stacking chair','Desk','Workstation','Conference table','Cabinet','Shelving'],
        true, true, 'What kind of furniture this is', 10);
      perform app.upsert_attribute(p_company, v_cat, 'material', 'Material', 'choice', null,
        array['Fabric','Leather','Faux leather','Mesh','Wood','Laminate','Metal','Glass','Plastic'],
        false, true, null, 20);
      perform app.upsert_attribute(p_company, v_cat, 'colour', 'Colour', 'text', null, '{}', false, true, null, 30);
      perform app.upsert_attribute(p_company, v_cat, 'width_mm', 'Width', 'dimension', 'mm', '{}', false, false, null, 40);
      perform app.upsert_attribute(p_company, v_cat, 'depth_mm', 'Depth', 'dimension', 'mm', '{}', false, false, null, 50);
      perform app.upsert_attribute(p_company, v_cat, 'height_mm', 'Height', 'dimension', 'mm', '{}', false, false, null, 60);
      perform app.upsert_attribute(p_company, v_cat, 'seats', 'Seats', 'number', null, '{}', false, false, 'For tables and benches', 70);
      perform app.upsert_attribute(p_company, v_cat, 'adjustable', 'Height adjustable', 'boolean', null, '{}', false, false, null, 80);
      v_n := v_n + 8;

    elsif v_name ~ '(generat|power|plant|machin|\mequipment\M|tool)' then
      perform app.upsert_attribute(p_company, v_cat, 'output_kva', 'Output', 'number', 'kVA', '{}', false, true, null, 10);
      perform app.upsert_attribute(p_company, v_cat, 'fuel_type', 'Fuel', 'choice', null,
        array['Diesel','Petrol','Gas','Electric'], false, true, null, 20);
      perform app.upsert_attribute(p_company, v_cat, 'engine_model', 'Engine', 'text', null, '{}', false, false, null, 30);
      perform app.upsert_attribute(p_company, v_cat, 'tank_litres', 'Tank capacity', 'number', 'L', '{}', false, false, null, 40);
      perform app.upsert_attribute(p_company, v_cat, 'phase', 'Phase', 'choice', null,
        array['Single phase','Three phase'], false, true, null, 50);
      perform app.upsert_attribute(p_company, v_cat, 'enclosure', 'Enclosure', 'choice', null,
        array['Open frame','Soundproof canopy'], false, false, null, 60);
      v_n := v_n + 6;

    elsif v_name ~ '(vehic|truck|\mcar\M|fleet|motor)' then
      perform app.upsert_attribute(p_company, v_cat, 'registration', 'Registration', 'text', null, '{}', false, true, null, 10);
      perform app.upsert_attribute(p_company, v_cat, 'body_type', 'Body', 'choice', null,
        array['Saloon','SUV','Pickup','Van','Truck','Bus','Trailer'], false, true, null, 20);
      perform app.upsert_attribute(p_company, v_cat, 'fuel_type', 'Fuel', 'choice', null,
        array['Petrol','Diesel','Hybrid','Electric'], false, true, null, 30);
      perform app.upsert_attribute(p_company, v_cat, 'engine_cc', 'Engine size', 'number', 'cc', '{}', false, false, null, 40);
      perform app.upsert_attribute(p_company, v_cat, 'seats', 'Seats', 'number', null, '{}', false, false, null, 50);
      v_n := v_n + 5;
    end if;
  end loop;

  return v_n;
end $$;

grant execute on function app.seed_attributes(uuid) to authenticated;
