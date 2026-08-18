-- ============================================================================
-- 0001_tenancy.sql
-- Companies, people, memberships, locations, and the access helpers every
-- other policy in the system is built on.
--
-- Design notes
--   * Every tenant-owned table carries company_id. No exceptions, ever.
--   * Access is decided by membership, not by a client-supplied "current
--     company". A client can lie about which company it is looking at; it
--     cannot lie about which rows exist in memberships.
--   * A membership with location_id IS NULL means "all locations in this
--     company". A membership with a location_id is scoped to that site.
--     A person can hold several memberships in one company.
--   * The helper functions are SECURITY DEFINER on purpose. Policies on
--     memberships would otherwise recurse into themselves when a policy on
--     another table asks "is this user a member?".
-- ============================================================================

-- pgcrypto: Supabase pre-installs it in the `extensions` schema, so a bare
-- CREATE EXTENSION IF NOT EXISTS is a silent no-op there and digest() then
-- fails to resolve. Locally the schema does not exist at all.
--
-- Create the schema either way and install into it only if the extension is
-- genuinely absent. Every SECURITY DEFINER function below pins
-- `search_path = app, extensions, public, pg_temp`, so the same SQL resolves
-- identically on Supabase and on a plain Postgres.
create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create extension pgcrypto with schema extensions;
  end if;
end $$;

grant usage on schema extensions to public;
create extension if not exists citext;

create schema if not exists app;

-- ---------------------------------------------------------------- enums ----
do $$ begin
  create type app.role_type as enum ('owner','admin','manager','requester','auditor');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.location_type as enum ('physical','virtual');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ companies ----
create table if not exists app.companies (
  id             uuid primary key default gen_random_uuid(),
  name           text        not null check (length(btrim(name)) between 2 and 200),
  legal_name     text,
  registration_no text,
  address        text,
  phone          text,
  brand_hex      text        not null default '#5B4BE8'
                   check (brand_hex ~ '^#[0-9A-Fa-f]{6}$'),
  logo_path      text,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------- profiles ----
-- Mirrors auth.users. On Supabase this is populated by a trigger on signup.
create table if not exists app.profiles (
  id          uuid primary key,          -- equals auth.users.id
  email       citext      not null unique,
  full_name   text,
  phone       text,
  avatar_path text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ locations ----
create table if not exists app.locations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  kind          app.location_type not null default 'physical',
  city          text,
  address       text,
  colour_hex    text not null default '#5B4BE8' check (colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  -- archived, never deleted: waybills and audit rows reference this by id
  archived_at   timestamptz,
  archived_by   uuid references app.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, name)
);

create index if not exists locations_company_idx
  on app.locations (company_id) where archived_at is null;

-- Exactly one virtual warehouse per company, created with the company and
-- never removable. It is where swept, retired and unassigned assets live.
create unique index if not exists locations_one_virtual_per_company
  on app.locations (company_id) where kind = 'virtual';

-- ---------------------------------------------------------- memberships ----
create table if not exists app.memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  user_id     uuid not null references app.profiles(id)  on delete cascade,
  location_id uuid references app.locations(id) on delete cascade,
  role        app.role_type not null,
  invited_by  uuid references app.profiles(id),
  created_at  timestamptz not null default now(),
  -- a person holds at most one membership per (company, location) pair;
  -- the NULL location case is handled by the partial index below
  constraint memberships_scope_uq unique (company_id, user_id, location_id)
);

create unique index if not exists memberships_company_wide_uq
  on app.memberships (company_id, user_id) where location_id is null;

create index if not exists memberships_user_idx    on app.memberships (user_id);
create index if not exists memberships_company_idx on app.memberships (company_id);

-- A location-scoped membership must point at a location in the same company.
create or replace function app.memberships_check_location()
returns trigger language plpgsql as $$
begin
  if new.location_id is not null then
    if not exists (
      select 1 from app.locations l
      where l.id = new.location_id and l.company_id = new.company_id
    ) then
      raise exception 'location % does not belong to company %',
        new.location_id, new.company_id
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists memberships_location_guard on app.memberships;
create trigger memberships_location_guard
  before insert or update on app.memberships
  for each row execute function app.memberships_check_location();

-- ================================================================ helpers ==
-- All SECURITY DEFINER with a pinned search_path. They read memberships
-- directly and therefore bypass RLS, which is what stops policy recursion.

create or replace function app.uid()
returns uuid language sql stable as $$
  select auth.uid()
$$;

create or replace function app.is_member(p_company uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (
    select 1 from app.memberships m
    where m.company_id = p_company and m.user_id = auth.uid()
  )
$$;

-- Highest role the user holds in a company. Ordering matters: the enum is
-- declared most-privileged first, so min() gives the strongest role.
create or replace function app.role_in(p_company uuid)
returns app.role_type
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select min(m.role) from app.memberships m
  where m.company_id = p_company and m.user_id = auth.uid()
$$;

create or replace function app.has_role(p_company uuid, variadic p_roles app.role_type[])
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (
    select 1 from app.memberships m
    where m.company_id = p_company
      and m.user_id = auth.uid()
      and m.role = any(p_roles)
  )
$$;

-- Purchase cost, supplier and invoice details sit behind this and nothing
-- else. A location manager runs their whole site without ever seeing them.
create or replace function app.can_see_financials(p_company uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select app.has_role(p_company, 'owner', 'admin', 'auditor')
$$;

-- True when the user may act at a specific location: either they hold a
-- company-wide membership, or one scoped to that location.
create or replace function app.can_access_location(p_company uuid, p_location uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (
    select 1 from app.memberships m
    where m.company_id = p_company
      and m.user_id = auth.uid()
      and (m.location_id is null or m.location_id = p_location)
  )
$$;

-- Read-only roles must not write anything, anywhere.
create or replace function app.can_write(p_company uuid)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select app.has_role(p_company, 'owner', 'admin', 'manager', 'requester')
$$;

-- --------------------------------------------------------- updated_at -----
create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['companies','profiles','locations'] loop
    execute format(
      'drop trigger if exists touch_%1$s on app.%1$s;
       create trigger touch_%1$s before update on app.%1$s
       for each row execute function app.touch_updated_at();', t);
  end loop;
end $$;

-- ------------------------------------------------- company bootstrapping ---
-- Creating a company must also create its owner membership and its virtual
-- warehouse, in one transaction. A company without an owner is unreachable;
-- a company without a virtual warehouse has nowhere to sweep assets to.
create or replace function app.create_company(
  p_name text,
  p_registration_no text default null,
  p_address text default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid;
  v_user    uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles p where p.id = v_user) then
    raise exception 'no profile for user %', v_user using errcode = '23503';
  end if;

  insert into app.companies (name, registration_no, address)
  values (p_name, p_registration_no, p_address)
  returning id into v_company;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_company, v_user, null, 'owner');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company, 'Virtual warehouse', 'virtual', 'No physical site', '#9296AC');

  return v_company;
end $$;

comment on function app.create_company is
  'Creates a company with its owner membership and virtual warehouse atomically.';
