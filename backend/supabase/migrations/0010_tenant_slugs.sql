-- ============================================================================
-- 0010_tenant_slugs.sql
-- Subdomain routing: zenith.nothingmissing.ng
--
-- Why subdomains rather than nothingmissing.ng/zenith:
--
-- A path is the same ORIGIN. Browsers scope cookies, localStorage and service
-- workers by origin, not by path, so every tenant on a path shares one cookie
-- jar. That deletes a whole layer of protection and leaves row-level security
-- carrying the isolation alone. A subdomain is a separate origin, so a session
-- token leaked into one tenant's tab is inert in another's — the browser
-- enforces it before any of our code runs.
--
-- It also buys two things a path cannot: a customer can later point their own
-- domain at us (assets.zenithfacilities.ng), and a large account can be moved
-- to separate infrastructure without their URL changing.
--
-- The apex keeps the paths that must stay simple: /l/<slug> for field links,
-- because a storekeeper on a cheap phone should not be bounced through a
-- redirect, and /<slug> as a convenience redirect to the subdomain.
-- ============================================================================

-- ------------------------------------------------------- reserved words ----
-- A company registering as "app" or "api" would shadow our own routes; one
-- registering as "admin" or "support" could impersonate us to their own staff.
-- Both are cheap to prevent now and painful to fix once a customer owns the
-- name and has printed it on a waybill.
create table if not exists app.reserved_slugs (
  slug   text primary key,
  reason text not null
);

insert into app.reserved_slugs (slug, reason) values
  -- our own routes
  ('www','infrastructure'), ('app','infrastructure'), ('api','infrastructure'),
  ('admin','infrastructure'), ('cdn','infrastructure'), ('static','infrastructure'),
  ('assets','infrastructure'), ('mail','infrastructure'), ('smtp','infrastructure'),
  ('ftp','infrastructure'), ('ns1','infrastructure'), ('ns2','infrastructure'),
  ('mx','infrastructure'), ('dev','infrastructure'), ('staging','infrastructure'),
  ('test','infrastructure'), ('demo','infrastructure'), ('sandbox','infrastructure'),
  ('l','field links live here'), ('s','short links'),
  -- product routes on the apex
  ('sign-in','product route'), ('signin','product route'), ('login','product route'),
  ('signup','product route'), ('register','product route'), ('logout','product route'),
  ('reset','product route'), ('invite','product route'), ('onboarding','product route'),
  ('pricing','marketing'), ('about','marketing'), ('blog','marketing'),
  ('docs','marketing'), ('help','marketing'), ('legal','marketing'),
  ('privacy','marketing'), ('terms','marketing'), ('contact','marketing'),
  ('status','marketing'), ('security','marketing'), ('field','product route'),
  -- things that could be used to impersonate us
  ('support','impersonation risk'), ('billing','impersonation risk'),
  ('account','impersonation risk'), ('accounts','impersonation risk'),
  ('nothingmissing','impersonation risk'), ('official','impersonation risk'),
  ('system','impersonation risk'), ('root','impersonation risk'),
  ('security-team','impersonation risk'), ('noreply','impersonation risk')
on conflict (slug) do nothing;

-- ------------------------------------------------------------- the slug ----
alter table app.companies
  add column if not exists slug text,
  -- a customer pointing their own domain at us, later
  add column if not exists custom_domain text,
  add column if not exists custom_domain_verified_at timestamptz;

-- Case-insensitive uniqueness: Zenith and zenith must not both exist, because
-- DNS does not distinguish them and neither will a person reading a waybill.
create unique index if not exists companies_slug_uq
  on app.companies (lower(slug)) where slug is not null;
create unique index if not exists companies_custom_domain_uq
  on app.companies (lower(custom_domain)) where custom_domain is not null;

-- The rules are the intersection of what DNS permits and what a person can
-- read aloud over a phone without ambiguity.
alter table app.companies drop constraint if exists companies_slug_ck;
alter table app.companies add constraint companies_slug_ck check (
  slug is null or (
    slug = lower(slug)                      -- lower case only, one canonical form
    and length(slug) between 3 and 40       -- 1-2 chars are too collision-prone
    and slug ~ '^[a-z][a-z0-9-]*[a-z0-9]$'  -- starts a letter, ends alphanumeric
    and slug !~ '--'                        -- no double hyphen (xn-- is punycode)
  )
);

-- ------------------------------------------------------ generating one -----
create or replace function app.slugify(p_text text)
returns text
language sql immutable as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(coalesce(p_text, '')),
            -- drop the company-form suffixes: "Zenith Facilities Ltd" -> "zenith-facilities"
            '\s+(ltd|limited|plc|inc|incorporated|llc|nig|nigeria|enterprises|ventures|company|co)\.?\s*$',
            '', 'gi'),
          '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g'),
      '-'),
    '')
$$;

-- Suggests a free slug, appending a numeric suffix only when it must.
create or replace function app.suggest_slug(p_name text)
returns text
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_base text; v_try text; v_n int := 1;
begin
  v_base := app.slugify(p_name);
  if v_base is null or length(v_base) < 3 then
    v_base := 'company';
  end if;
  v_base := left(v_base, 34);
  v_base := regexp_replace(v_base, '[^a-z0-9]+$', '');

  v_try := v_base;
  while exists (select 1 from app.reserved_slugs r where r.slug = v_try)
     or exists (select 1 from app.companies c where lower(c.slug) = v_try)
  loop
    v_n := v_n + 1;
    v_try := v_base || '-' || v_n;
    exit when v_n > 200;   -- give up rather than spin
  end loop;

  return v_try;
end $$;

create or replace function app.slug_available(p_slug text)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_reason text;
begin
  p_slug := lower(btrim(coalesce(p_slug, '')));

  if p_slug = '' then
    return jsonb_build_object('available', false, 'reason', 'Choose an address.');
  end if;
  if length(p_slug) < 3 then
    return jsonb_build_object('available', false,
      'reason', 'Too short — three characters or more.');
  end if;
  if length(p_slug) > 40 then
    return jsonb_build_object('available', false, 'reason', 'Too long — forty at most.');
  end if;
  -- Note: p_slug was lowercased on entry, so "Zenith" and "zenith" are one
  -- address. DNS does not distinguish them and neither should we — otherwise
  -- two companies could claim what is, in practice, the same URL.
  if p_slug !~ '^[a-z][a-z0-9-]*[a-z0-9]$' or p_slug ~ '--' then
    return jsonb_build_object('available', false,
      'reason', 'Letters, numbers and single hyphens only, starting with a letter.');
  end if;

  select r.reason into v_reason from app.reserved_slugs r where r.slug = p_slug;
  if found then
    return jsonb_build_object('available', false, 'reason', 'That address is reserved.');
  end if;

  if exists (select 1 from app.companies c where lower(c.slug) = p_slug) then
    -- Do not confirm that a specific company exists at that address: it would
    -- let anyone enumerate the customer list one guess at a time.
    return jsonb_build_object('available', false, 'reason', 'That address is taken.');
  end if;

  return jsonb_build_object('available', true,
    'url', format('https://%s.nothingmissing.ng', p_slug));
end $$;

-- Claiming a slug is a one-time act. Changing it later breaks every link a
-- customer has already sent, every bookmark, and every waybill footer — so it
-- is deliberately not something the interface offers.
create or replace function app.claim_slug(p_company uuid, p_slug text)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_check jsonb; v_existing text;
begin
  if not app.has_role(p_company, 'owner') then
    raise exception 'only an owner can set the company address'
      using errcode = '42501';
  end if;

  select slug into v_existing from app.companies where id = p_company;
  if v_existing is not null then
    raise exception 'this company already lives at %.nothingmissing.ng', v_existing
      using errcode = 'check_violation',
            hint = 'Changing it would break every link already shared. Contact support if it is genuinely wrong.';
  end if;

  p_slug := lower(btrim(p_slug));
  v_check := app.slug_available(p_slug);
  if not (v_check ->> 'available')::boolean then
    raise exception '%', v_check ->> 'reason' using errcode = 'check_violation';
  end if;

  update app.companies set slug = p_slug where id = p_company;

  perform app.log(p_company, 'claimed a company address', 'companies',
    p_company::text, p_slug,
    format('This company is now at %s.nothingmissing.ng', p_slug), 'ok');

  return p_slug;
end $$;

-- ------------------------------------------------------------ resolving ----
-- Called by the routing layer on every request, before authentication. It
-- returns only what is needed to paint a login page — name, colour, logo —
-- and nothing about who works there or what they own.
create or replace function app.resolve_tenant(p_host text)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_slug text; v_c app.companies%rowtype;
begin
  p_host := lower(btrim(coalesce(p_host, '')));
  p_host := regexp_replace(p_host, ':[0-9]+$', '');      -- strip any port

  -- A verified custom domain wins: assets.zenithfacilities.ng
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

  -- Public-facing only. Deliberately no membership, asset or financial data:
  -- this runs unauthenticated on every page load.
  return jsonb_build_object(
    'tenant',     v_c.id,
    'slug',       v_c.slug,
    'name',       v_c.name,
    'brand_hex',  v_c.brand_hex,
    'logo_path',  v_c.logo_path,
    'url',        format('https://%s.nothingmissing.ng', v_c.slug));
end $$;

comment on function app.resolve_tenant is
  'Host to tenant, for the routing layer. Unauthenticated: returns branding only.';

-- --------------------------------------------------------- custom domains --
create or replace function app.request_custom_domain(p_company uuid, p_domain text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_token text;
begin
  if not app.has_role(p_company, 'owner') then
    raise exception 'only an owner can add a custom domain' using errcode = '42501';
  end if;
  p_domain := lower(btrim(p_domain));
  if p_domain !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'that does not look like a domain name' using errcode = 'check_violation';
  end if;
  if p_domain like '%nothingmissing.ng' then
    raise exception 'use a company address instead for our own domain'
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from app.companies
             where lower(custom_domain) = p_domain and id <> p_company) then
    raise exception 'that domain is already claimed' using errcode = 'unique_violation';
  end if;

  -- Verification proves control of the DNS before we serve anything there.
  v_token := 'nm-verify=' || encode(gen_random_bytes(16), 'hex');

  update app.companies
     set custom_domain = p_domain, custom_domain_verified_at = null
   where id = p_company;

  perform app.log(p_company, 'requested a custom domain', 'companies',
    p_company::text, p_domain, 'Awaiting DNS verification', 'info');

  return jsonb_build_object(
    'domain', p_domain,
    'txt_record', v_token,
    'cname_target', 'cname.nothingmissing.ng',
    'note', 'Add both records, then verification runs automatically.');
end $$;

-- ---------------------------------------------------------------- RLS ------
alter table app.reserved_slugs enable row level security;
alter table app.reserved_slugs force row level security;

-- Readable by anyone, including anon: the sign-up form needs to say "that one
-- is reserved" before an account exists. There is nothing sensitive in it.
drop policy if exists reserved_select on app.reserved_slugs;
create policy reserved_select on app.reserved_slugs for select using (true);

revoke insert, update, delete on app.reserved_slugs from authenticated, anon;
grant select on app.reserved_slugs to anon, authenticated;

-- The routing layer and the sign-up form both run before authentication.
grant execute on function app.resolve_tenant(text)  to anon, authenticated;
grant execute on function app.slug_available(text)  to anon, authenticated;
grant execute on function app.suggest_slug(text)    to anon, authenticated;

-- ------------------------------------------------ create_company, updated --
-- CREATE OR REPLACE cannot change a signature: adding p_slug would create a
-- second overload rather than replacing the original, and every three-argument
-- call would then be ambiguous. Drop the old one explicitly. This is the kind
-- of thing that passes review and fails on deploy.
drop function if exists app.create_company(text, text, text);

-- Claiming the address is part of creating the company, so a tenant can never
-- exist without somewhere to live.
create or replace function app.create_company(
  p_name text,
  p_registration_no text default null,
  p_address text default null,
  p_slug text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid;
  v_user    uuid := auth.uid();
  v_slug    text;
  v_check   jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles p where p.id = v_user) then
    raise exception 'no profile for user %', v_user using errcode = '23503';
  end if;

  v_slug := lower(btrim(coalesce(nullif(p_slug, ''), app.suggest_slug(p_name))));
  v_check := app.slug_available(v_slug);
  if not (v_check ->> 'available')::boolean then
    raise exception '%', v_check ->> 'reason' using errcode = 'check_violation';
  end if;

  insert into app.companies (name, registration_no, address, slug)
  values (p_name, p_registration_no, p_address, v_slug)
  returning id into v_company;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_company, v_user, null, 'owner');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company, 'Virtual warehouse', 'virtual', 'No physical site', '#9296AC');

  return jsonb_build_object(
    'company_id', v_company,
    'slug',       v_slug,
    'url',        format('https://%s.nothingmissing.ng', v_slug));
end $$;

-- Existing rows predate slugs; give them one so nothing is unreachable.
update app.companies c
   set slug = app.suggest_slug(c.name)
 where c.slug is null;

-- A backfill only fixes rows that exist when the migration runs. Anything
-- inserted afterwards without going through create_company() — a seed script,
-- a support fix, a future import — would have no address and be unreachable
-- by routing. A trigger closes that hole permanently.
create or replace function app.companies_ensure_slug()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if new.slug is null then
    new.slug := app.suggest_slug(new.name);
  end if;
  return new;
end $$;

drop trigger if exists companies_slug_guard on app.companies;
create trigger companies_slug_guard
  before insert on app.companies
  for each row execute function app.companies_ensure_slug();
