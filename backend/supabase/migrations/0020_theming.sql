-- ============================================================================
-- 0020_theming.sql
-- Company appearance, and personal view preferences.
--
-- Two different things that both look like "settings", kept apart deliberately.
--
-- COMPANY THEME is one person's decision applied to everyone: the colour, the
-- logo, what prints on a waybill. It belongs to the company and only an owner
-- or admin may change it.
--
-- VIEW PREFERENCES are personal: which columns you want on the register, how
-- dense you like tables, where you land after signing in. A location manager
-- checking deliveries all day and an owner reading reports want different
-- defaults, and neither should be able to impose theirs on the other.
--
-- The constraint on theming is deliberate and worth stating: a company picks
-- ONE colour and everything else derives from it. Handing someone six pickers
-- produces documents with their name on them that they would be embarrassed to
-- send to a customer.
-- ============================================================================

-- --------------------------------------------------------- company theme ---
alter table app.companies
  add column if not exists accent_hex text
    check (accent_hex is null or accent_hex ~ '^#[0-9A-Fa-f]{6}$'),
  add column if not exists logo_updated_at timestamptz,
  add column if not exists theme_mode text not null default 'light'
    check (theme_mode in ('light', 'dark')),
  add column if not exists document_footer text,
  add column if not exists show_logo_on_documents boolean not null default true;

-- The brand colour already exists from 0001. This records where it came from,
-- because a colour picked from an uploaded logo should not be silently
-- overwritten by a later logo upload if the person has since chosen their own.
alter table app.companies
  add column if not exists brand_source text not null default 'default'
    check (brand_source in ('default', 'chosen', 'from_logo'));

-- ---------------------------------------------------- view preferences -----
create table if not exists app.view_preferences (
  user_id     uuid not null references app.profiles(id) on delete cascade,
  company_id  uuid not null references app.companies(id) on delete cascade,
  -- where signing in takes you
  landing     text not null default 'dashboard'
    check (landing in ('dashboard','assets','transfers','submissions','inventory')),
  density     text not null default 'comfortable'
    check (density in ('comfortable','compact')),
  -- which columns the register shows, in order. An empty array means the
  -- default set, so adding a new column later does not leave everyone who
  -- saved a preference stuck without it.
  asset_columns text[] not null default '{}',
  -- filters that survive a sign-out, for someone who only ever looks at one site
  default_location uuid references app.locations(id) on delete set null,
  hide_retired  boolean not null default true,
  updated_at    timestamptz not null default now(),
  primary key (user_id, company_id)
);

alter table app.view_preferences enable row level security;
alter table app.view_preferences force row level security;

-- Yours and nobody else's, in either direction. An owner cannot read what
-- columns a manager prefers, because it is not their business and because a
-- preference table is not a surveillance tool.
drop policy if exists view_prefs_select on app.view_preferences;
create policy view_prefs_select on app.view_preferences
  for select using ( user_id = auth.uid() );

drop policy if exists view_prefs_insert on app.view_preferences;
create policy view_prefs_insert on app.view_preferences
  for insert with check ( user_id = auth.uid() and app.is_member(company_id) );

drop policy if exists view_prefs_update on app.view_preferences;
create policy view_prefs_update on app.view_preferences
  for update
  using      ( user_id = auth.uid() )
  with check ( user_id = auth.uid() );

drop policy if exists view_prefs_delete on app.view_preferences;
create policy view_prefs_delete on app.view_preferences
  for delete using ( user_id = auth.uid() );

create or replace function app.save_view_preferences(
  p_company  uuid,
  p_landing  text default null,
  p_density  text default null,
  p_columns  text[] default null,
  p_location uuid default null,
  p_hide_retired boolean default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null or not app.is_member(p_company) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  insert into app.view_preferences (user_id, company_id)
  values (v_user, p_company)
  on conflict (user_id, company_id) do nothing;

  update app.view_preferences
     set landing = coalesce(p_landing, landing),
         density = coalesce(p_density, density),
         asset_columns = coalesce(p_columns, asset_columns),
         -- a null location is a real choice ("all locations"), so it cannot
         -- use coalesce; the caller passes the sentinel below to clear it
         default_location = case
           when p_location = '00000000-0000-0000-0000-000000000000'::uuid then null
           else coalesce(p_location, default_location) end,
         hide_retired = coalesce(p_hide_retired, hide_retired),
         updated_at = now()
   where user_id = v_user and company_id = p_company;

  return jsonb_build_object('saved', true);
end $$;

grant execute on function app.save_view_preferences(uuid, text, text, text[], uuid, boolean)
  to authenticated;

-- ------------------------------------------------------------- branding ----
-- One colour, and the tints derive from it. The check on contrast is the
-- reason this is a function rather than a plain update: a company that picks a
-- pale yellow produces waybills nobody can read, and the first they know of it
-- is a customer complaining.
create or replace function app.set_company_theme(
  p_company uuid,
  p_brand   text default null,
  p_accent  text default null,
  p_mode    text default null,
  p_footer  text default null,
  p_show_logo boolean default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r int; v_g int; v_b int; v_lum numeric;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can change how the company looks.'
      using errcode = '42501';
  end if;

  if p_brand is not null then
    if p_brand !~ '^#[0-9A-Fa-f]{6}$' then
      raise exception 'That is not a colour. Use a hex value like #0551BD.'
        using errcode = 'check_violation';
    end if;

    -- Relative luminance, the same formula browsers use for contrast. A brand
    -- colour is used for white text on buttons and for document accents, so it
    -- has to be dark enough to carry white.
    v_r := ('x' || substr(p_brand, 2, 2))::bit(8)::int;
    v_g := ('x' || substr(p_brand, 4, 2))::bit(8)::int;
    v_b := ('x' || substr(p_brand, 6, 2))::bit(8)::int;
    v_lum := (0.2126 * v_r + 0.7152 * v_g + 0.0722 * v_b) / 255;

    if v_lum > 0.62 then
      raise exception 'That colour is too pale for white text to sit on it.'
        using errcode = 'check_violation',
              hint = 'Pick something darker, or it will print as an unreadable waybill.';
    end if;

    update app.companies
       set brand_hex = upper(p_brand), brand_source = 'chosen'
     where id = p_company;
  end if;

  update app.companies
     set accent_hex = coalesce(nullif(p_accent, ''), accent_hex),
         theme_mode = coalesce(p_mode, theme_mode),
         document_footer = coalesce(p_footer, document_footer),
         show_logo_on_documents = coalesce(p_show_logo, show_logo_on_documents),
         updated_at = now()
   where id = p_company;

  perform app.log(p_company, 'changed the company appearance', 'companies',
    p_company::text, null,
    coalesce('brand ' || p_brand, 'theme updated'), 'info');

  return jsonb_build_object('ok', true);
end $$;

grant execute on function app.set_company_theme(uuid, text, text, text, text, boolean)
  to authenticated;

create or replace function app.set_company_logo(p_company uuid, p_path text)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can change the logo.' using errcode = '42501';
  end if;
  update app.companies
     set logo_path = nullif(btrim(coalesce(p_path, '')), ''),
         logo_updated_at = now(), updated_at = now()
   where id = p_company;
  perform app.log(p_company, 'updated the company logo', 'companies', p_company::text,
    null, case when p_path is null then 'Removed' else 'Uploaded' end, 'info');
end $$;

grant execute on function app.set_company_logo(uuid, text) to authenticated;

-- resolve_tenant already returns brand_hex and logo_path for the sign-in page.
-- Extend it so an unauthenticated visitor gets everything needed to paint a
-- branded login without a second round trip — and still nothing more.
create or replace function app.resolve_tenant(p_host text)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_slug text; v_c app.companies%rowtype;
begin
  p_host := lower(btrim(coalesce(p_host, '')));
  p_host := regexp_replace(p_host, ':[0-9]+$', '');

  select * into v_c from app.companies
   where lower(custom_domain) = p_host and custom_domain_verified_at is not null
     and archived_at is null;

  if not found then
    if p_host like '%.nothingmissing.ng' then
      v_slug := split_part(p_host, '.', 1);
    else
      return jsonb_build_object('tenant', null, 'reason', 'apex_or_unknown_host');
    end if;

    if exists (select 1 from app.reserved_slugs where slug = v_slug) then
      return jsonb_build_object('tenant', null, 'reason', 'reserved');
    end if;

    select * into v_c from app.companies
     where lower(slug) = v_slug and archived_at is null;
    if not found then
      return jsonb_build_object('tenant', null, 'reason', 'not_found');
    end if;
  end if;

  return jsonb_build_object(
    'tenant', v_c.id, 'slug', v_c.slug, 'name', v_c.name,
    'brand_hex', v_c.brand_hex, 'accent_hex', v_c.accent_hex,
    'theme_mode', v_c.theme_mode, 'logo_path', v_c.logo_path,
    'url', format('https://%s.nothingmissing.ng', v_c.slug));
end $$;


-- The waybill snapshot froze company details before logos existed. Include the
-- logo path so a document issued today still carries the mark it was issued
-- with, even if the company changes it next month.
create or replace function app.issue_waybill_document(p_transfer uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t app.transfers%rowtype; v_c app.companies%rowtype;
  v_snap jsonb; v_rev int; v_label text;
begin
  select * into v_t from app.transfers where id = p_transfer;
  if not found then
    raise exception 'That consignment does not exist.' using errcode = 'no_data_found';
  end if;
  if not app.is_member(v_t.company_id) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_t.waybill_no is null then
    raise exception 'No waybill has been issued yet — dispatch it first.'
      using errcode = 'check_violation';
  end if;

  select * into v_c from app.companies where id = v_t.company_id;
  select coalesce(max(revision), 0) + 1 into v_rev
    from app.waybill_documents where transfer_id = p_transfer;
  select coalesce(full_name, email::text, 'System') into v_label
    from app.profiles where id = auth.uid();

  v_snap := jsonb_build_object(
    'company', jsonb_build_object(
      'name', v_c.name, 'registration_no', v_c.registration_no,
      'address', v_c.address, 'phone', v_c.phone, 'brand_hex', v_c.brand_hex,
      'logo_path', case when v_c.show_logo_on_documents then v_c.logo_path else null end,
      'footer', v_c.document_footer),
    'waybill', jsonb_build_object(
      'number', v_t.waybill_no, 'reference', v_t.reference,
      'issued_at', v_t.waybill_issued_at, 'reason', v_t.reason,
      'driver', v_t.driver_name, 'vehicle', v_t.vehicle_reg),
    'route', jsonb_build_object(
      'from', (select jsonb_build_object('name', name, 'address', address, 'city', city)
               from app.locations where id = v_t.from_location),
      'to',   (select jsonb_build_object('name', name, 'address', address, 'city', city)
               from app.locations where id = v_t.to_location)),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'tag', a.tag, 'name', a.name, 'serial', a.serial_no,
        'model', m.name, 'brand', b.name) order by a.tag), '[]'::jsonb)
      from app.transfer_lines tl
      join app.assets a on a.id = tl.asset_id
      left join app.models m on m.id = a.model_id
      left join app.brands b on b.id = m.brand_id
      where tl.transfer_id = p_transfer));

  insert into app.waybill_documents
    (company_id, transfer_id, waybill_no, revision, snapshot, issued_by, issued_label)
  values (v_t.company_id, p_transfer, v_t.waybill_no, v_rev, v_snap, auth.uid(),
          coalesce(v_label, 'Unknown'));

  if v_rev > 1 then
    perform app.log(v_t.company_id, 'reissued a waybill', 'transfers', p_transfer::text,
      v_t.waybill_no, format('revision %s — the original stays in the archive', v_rev),
      'warn', v_t.to_location);
  end if;

  return v_snap || jsonb_build_object('revision', v_rev);
end $$;
