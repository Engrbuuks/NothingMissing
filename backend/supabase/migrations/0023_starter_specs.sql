-- ============================================================================
-- 0023_starter_specs.sql
-- Attribute packs, so the description system is usable on day one.
--
-- 0022 built the mechanism: attributes defined per category, values on models,
-- overrides on individual assets. What it did not do is give anyone a starting
-- point — and an empty attribute editor is exactly as useless as the freeform
-- jsonb box it replaced. Somebody opening it has to invent "what does a chair
-- have?" before they can describe a single chair, so they skip it, and the
-- catalog stays empty.
--
-- So: seven packs covering what a Nigerian multi-site company actually owns.
-- They are applied on request, not forced. A company that wants its own scheme
-- ignores them; a company that wants to get moving picks the ones that match
-- and edits from there.
--
-- The packs are deliberately SHORT. Fifteen attributes on a chair means nobody
-- fills any of them in. Six means the form is answerable in a minute, and six
-- filled fields beat fifteen empty ones.
-- ============================================================================

-- Every pack is (category name, then the attributes). Applying one creates the
-- category if it is missing, so a new company gets a working hierarchy rather
-- than attributes with nothing to attach to.
create or replace function app.apply_attribute_pack(p_company uuid, p_pack text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_cat  uuid;
  v_name text;
  v_n    int := 0;
  v_sub  text;
begin
  if not app.has_role(p_company, 'owner', 'admin', 'manager') then
    raise exception 'Only an owner, admin or manager can set up specifications.'
      using errcode = '42501';
  end if;

  v_name := case p_pack
    when 'computers'   then 'IT equipment'
    when 'furniture'   then 'Furniture'
    when 'generators'  then 'Power'
    when 'vehicles'    then 'Vehicles'
    when 'tools'       then 'Tools and plant'
    when 'safety'      then 'Safety equipment'
    when 'network'     then 'Network and comms'
    else null end;

  if v_name is null then
    raise exception 'No such pack: %', p_pack using errcode = 'check_violation';
  end if;

  select id into v_cat from app.categories
   where company_id = p_company and lower(name) = lower(v_name);

  if v_cat is null then
    insert into app.categories (company_id, name) values (p_company, v_name)
    returning id into v_cat;
  end if;

  -- A category needs at least one type under it, or a model cannot be created.
  v_sub := case p_pack
    when 'computers'  then 'Desktop computer'
    when 'furniture'  then 'Seating'
    when 'generators' then 'Diesel generator'
    when 'vehicles'   then 'Light vehicle'
    when 'tools'      then 'Power tool'
    when 'safety'     then 'Personal protective equipment'
    when 'network'    then 'Network device'
    end;

  insert into app.sub_categories (company_id, category_id, name)
  values (p_company, v_cat, v_sub)
  on conflict do nothing;

  -- ---- computers ---------------------------------------------------------
  if p_pack = 'computers' then
    perform app.upsert_attribute(p_company, v_cat, 'form_factor', 'Form factor', 'choice',
      null, array['All-in-one','Desktop tower','Small form factor','Laptop','Mini PC'],
      true, true, 'All-in-one means the computer is built into the screen.', 10);
    perform app.upsert_attribute(p_company, v_cat, 'processor', 'Processor', 'text',
      null, null, true, true, 'As printed on the sticker, e.g. Intel Core i5-12400.', 20);
    perform app.upsert_attribute(p_company, v_cat, 'memory_gb', 'Memory', 'number',
      'GB', null, true, true, 'RAM installed. Upgrade one machine and override it on that asset, not on the model.', 30);
    perform app.upsert_attribute(p_company, v_cat, 'storage_gb', 'Storage', 'number',
      'GB', null, false, true, null, 40);
    perform app.upsert_attribute(p_company, v_cat, 'storage_type', 'Storage type', 'choice',
      null, array['SSD','HDD','SSD + HDD'], false, true, null, 50);
    perform app.upsert_attribute(p_company, v_cat, 'screen_in', 'Screen size', 'number',
      'in', null, false, true, 'Diagonal, in inches. Leave blank for a tower with no screen.', 60);
    v_n := 6;
  end if;

  -- ---- furniture ---------------------------------------------------------
  if p_pack = 'furniture' then
    perform app.upsert_attribute(p_company, v_cat, 'item_type', 'Type', 'choice',
      null, array['Task chair','Visitor chair','Executive chair','Desk','Meeting table','Cabinet','Shelving'],
      true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'material', 'Material', 'choice',
      null, array['Mesh','Fabric','Leather','Faux leather','Wood','Laminate','Steel','Glass'],
      true, true, 'The surface somebody touches — the seat, or the table top.', 20);
    perform app.upsert_attribute(p_company, v_cat, 'colour', 'Colour', 'colour',
      null, null, false, true, null, 30);
    perform app.upsert_attribute(p_company, v_cat, 'dimensions', 'Dimensions', 'dimension',
      'mm', null, false, false, 'Width × depth × height in millimetres.', 40);
    perform app.upsert_attribute(p_company, v_cat, 'adjustable', 'Height adjustable', 'boolean',
      null, null, false, true, null, 50);
    perform app.upsert_attribute(p_company, v_cat, 'seats', 'Seats', 'number',
      null, null, false, false, 'For tables only — how many people it takes.', 60);
    v_n := 6;
  end if;

  -- ---- generators --------------------------------------------------------
  if p_pack = 'generators' then
    perform app.upsert_attribute(p_company, v_cat, 'output_kva', 'Output', 'number',
      'kVA', null, true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'fuel', 'Fuel', 'choice',
      null, array['Diesel','Petrol','Gas','Dual fuel'], true, true, null, 20);
    perform app.upsert_attribute(p_company, v_cat, 'engine', 'Engine', 'text',
      null, null, false, true, 'Engine model, which is often not the same as the set model.', 30);
    perform app.upsert_attribute(p_company, v_cat, 'tank_litres', 'Tank capacity', 'number',
      'L', null, false, false, 'What a full tank holds. The fuel check uses this.', 40);
    perform app.upsert_attribute(p_company, v_cat, 'enclosure', 'Enclosure', 'choice',
      null, array['Soundproof canopy','Open frame','Containerised'], false, true, null, 50);
    perform app.upsert_attribute(p_company, v_cat, 'phase', 'Phase', 'choice',
      null, array['Single phase','Three phase'], false, true, null, 60);
    v_n := 6;
  end if;

  -- ---- vehicles ----------------------------------------------------------
  if p_pack = 'vehicles' then
    perform app.upsert_attribute(p_company, v_cat, 'body', 'Body type', 'choice',
      null, array['Saloon','SUV','Pickup','Bus','Truck','Trailer','Motorcycle'], true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'fuel', 'Fuel', 'choice',
      null, array['Petrol','Diesel','Hybrid','Electric'], true, true, null, 20);
    perform app.upsert_attribute(p_company, v_cat, 'engine_cc', 'Engine size', 'number',
      'cc', null, false, true, null, 30);
    perform app.upsert_attribute(p_company, v_cat, 'seats', 'Seats', 'number',
      null, null, false, true, null, 40);
    perform app.upsert_attribute(p_company, v_cat, 'payload_kg', 'Payload', 'number',
      'kg', null, false, false, 'For pickups and trucks.', 50);
    perform app.upsert_attribute(p_company, v_cat, 'transmission', 'Transmission', 'choice',
      null, array['Manual','Automatic'], false, true, null, 60);
    v_n := 6;
  end if;

  -- ---- tools -------------------------------------------------------------
  if p_pack = 'tools' then
    perform app.upsert_attribute(p_company, v_cat, 'power', 'Power source', 'choice',
      null, array['Mains','Battery','Petrol','Diesel','Pneumatic','Manual'], true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'voltage', 'Voltage', 'number',
      'V', null, false, true, 'For battery tools this is the battery, not the mains.', 20);
    perform app.upsert_attribute(p_company, v_cat, 'capacity', 'Capacity', 'text',
      null, null, false, false, 'Chuck size, blade diameter, bore — whatever describes its reach.', 30);
    perform app.upsert_attribute(p_company, v_cat, 'weight_kg', 'Weight', 'number',
      'kg', null, false, false, 'Matters when one person has to carry it up a ladder.', 40);
    perform app.upsert_attribute(p_company, v_cat, 'calibration', 'Needs calibration', 'boolean',
      null, null, false, true, 'Torque wrenches and meters do. If true, set a service interval on the model.', 50);
    v_n := 5;
  end if;

  -- ---- safety ------------------------------------------------------------
  if p_pack = 'safety' then
    perform app.upsert_attribute(p_company, v_cat, 'ppe_type', 'Type', 'choice',
      null, array['Helmet','Boots','Gloves','Goggles','Harness','Hi-vis','Ear defenders','Respirator'],
      true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'size', 'Size', 'text',
      null, null, false, true, 'Boots and gloves need this; a helmet usually does not.', 20);
    perform app.upsert_attribute(p_company, v_cat, 'standard', 'Standard', 'text',
      null, null, false, true, 'e.g. EN 397, ANSI Z89.1. What an inspector asks for.', 30);
    perform app.upsert_attribute(p_company, v_cat, 'expires', 'Expires', 'boolean',
      null, null, true, true, 'Harnesses and helmets expire. If true, record the date on each unit.', 40);
    perform app.upsert_attribute(p_company, v_cat, 'shelf_life_months', 'Shelf life', 'number',
      'months', null, false, false, 'From manufacture, not from issue.', 50);
    v_n := 5;
  end if;

  -- ---- network -----------------------------------------------------------
  if p_pack = 'network' then
    perform app.upsert_attribute(p_company, v_cat, 'device_type', 'Device type', 'choice',
      null, array['Router','Switch','Access point','Firewall','NVR','Camera','UPS'], true, true, null, 10);
    perform app.upsert_attribute(p_company, v_cat, 'ports', 'Ports', 'number',
      null, null, false, true, null, 20);
    perform app.upsert_attribute(p_company, v_cat, 'poe', 'Power over Ethernet', 'boolean',
      null, null, false, true, null, 30);
    perform app.upsert_attribute(p_company, v_cat, 'mount', 'Mounting', 'choice',
      null, array['Rack','Wall','Desktop','Ceiling','Pole'], false, true, null, 40);
    perform app.upsert_attribute(p_company, v_cat, 'throughput', 'Speed', 'text',
      null, null, false, false, 'e.g. 1 Gbps, Wi-Fi 6.', 50);
    v_n := 5;
  end if;

  perform app.log(p_company, 'set up specifications', 'attributes', v_cat::text, v_name,
    format('%s attributes added to %s', v_n, v_name), 'info');

  return jsonb_build_object('category_id', v_cat, 'category', v_name, 'attributes', v_n);
end $$;

grant execute on function app.apply_attribute_pack(uuid, text) to authenticated;

-- What a company can choose from, with a count of what it already has, so the
-- screen can say "already set up" rather than offering the same pack twice.
create or replace function app.available_packs(p_company uuid)
returns table (pack text, name text, description text, attributes int, applied boolean)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  with packs(pack, name, description, attributes) as (values
    ('computers',  'IT equipment',       'Form factor, processor, memory, storage, screen size', 6),
    ('furniture',  'Furniture',          'Type, material, colour, dimensions, adjustability, seats', 6),
    ('generators', 'Power',              'Output, fuel, engine, tank, enclosure, phase', 6),
    ('vehicles',   'Vehicles',           'Body, fuel, engine size, seats, payload, transmission', 6),
    ('tools',      'Tools and plant',    'Power source, voltage, capacity, weight, calibration', 5),
    ('safety',     'Safety equipment',   'Type, size, standard, expiry, shelf life', 5),
    ('network',    'Network and comms',  'Device type, ports, PoE, mounting, speed', 5)
  )
  select p.pack, p.name, p.description, p.attributes,
         exists (
           select 1 from app.categories c
           join app.attributes a on a.category_id = c.id
           where c.company_id = p_company and lower(c.name) = lower(p.name)
         )
  from packs p
  where app.is_member(p_company)
  order by p.name
$$;

grant execute on function app.available_packs(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Where does a thing belong? The register cannot answer this for somebody, but
-- it can stop them putting a serial-numbered machine into inventory where it
-- becomes a number and loses its history.
--
-- Called when a stock item is created, as a warning rather than a refusal: a
-- company that genuinely counts its chairs rather than tracking them is not
-- wrong, and being told it is wrong by software is how people stop reading
-- messages.
-- ---------------------------------------------------------------------------
create or replace function app.classification_hint(p_name text)
returns jsonb
language plpgsql immutable as $$
declare v text := lower(coalesce(p_name, ''));
begin
  if v ~ '(laptop|computer|desktop|monitor|printer|generator|vehicle|truck|camera|router|switch|server|phone|tablet)' then
    return jsonb_build_object(
      'warn', true,
      'message', 'This sounds like something with a serial number.',
      'detail', 'Inventory counts things that are interchangeable — one litre of diesel is like any other. Anything you would ever ask "where is that specific one?" about belongs on the asset register instead, where it keeps its own history.');
  end if;
  return jsonb_build_object('warn', false);
end $$;

grant execute on function app.classification_hint(text) to authenticated;
