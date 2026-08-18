-- ============================================================================
-- 0002_rls_tenancy.sql
-- Row level security for the tenancy tables.
--
-- The rule this whole file follows: every policy that permits a write states
-- WITH CHECK as well as USING. A `for all using (...)` without a matching
-- WITH CHECK lets a caller update a row they can see into a shape they should
-- not be able to create — silently, with no error. Paired, always.
--
-- Policies are written per-command rather than `for all` so the read rule and
-- the write rule can differ, which they usually should.
-- ============================================================================

alter table app.companies   enable row level security;
alter table app.profiles    enable row level security;
alter table app.locations   enable row level security;
alter table app.memberships enable row level security;

alter table app.companies   force row level security;
alter table app.profiles    force row level security;
alter table app.locations   force row level security;
alter table app.memberships force row level security;

-- ------------------------------------------------------------ companies ----
drop policy if exists companies_select on app.companies;
create policy companies_select on app.companies
  for select using ( app.is_member(id) );

-- Companies are created through app.create_company(), never by direct insert:
-- a bare insert would produce a company with no owner and no warehouse.
drop policy if exists companies_update on app.companies;
create policy companies_update on app.companies
  for update
  using      ( app.has_role(id, 'owner', 'admin') )
  with check ( app.has_role(id, 'owner', 'admin') );

-- No delete policy at all. Companies archive; they do not disappear.

-- ------------------------------------------------------------- profiles ----
-- You can read the profile of anyone you share a company with, so names can
-- be shown on approvals and audit rows. You can only edit your own.
drop policy if exists profiles_select on app.profiles;
create policy profiles_select on app.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1
      from app.memberships mine
      join app.memberships theirs on theirs.company_id = mine.company_id
      where mine.user_id = auth.uid() and theirs.user_id = app.profiles.id
    )
  );

drop policy if exists profiles_insert on app.profiles;
create policy profiles_insert on app.profiles
  for insert with check ( id = auth.uid() );

drop policy if exists profiles_update on app.profiles;
create policy profiles_update on app.profiles
  for update
  using      ( id = auth.uid() )
  with check ( id = auth.uid() );

-- ------------------------------------------------------------ locations ----
drop policy if exists locations_select on app.locations;
create policy locations_select on app.locations
  for select using ( app.is_member(company_id) );

drop policy if exists locations_insert on app.locations;
create policy locations_insert on app.locations
  for insert with check ( app.has_role(company_id, 'owner', 'admin') );

drop policy if exists locations_update on app.locations;
create policy locations_update on app.locations
  for update
  using      ( app.has_role(company_id, 'owner', 'admin') )
  with check ( app.has_role(company_id, 'owner', 'admin') );

-- No delete policy. Locations archive. See app.archive_location() in 0005.

-- ---------------------------------------------------------- memberships ----
-- Everyone in a company can see who else is in it. Only owners and admins
-- can grant, change or revoke access.
drop policy if exists memberships_select on app.memberships;
create policy memberships_select on app.memberships
  for select using ( app.is_member(company_id) );

drop policy if exists memberships_insert on app.memberships;
create policy memberships_insert on app.memberships
  for insert with check ( app.has_role(company_id, 'owner', 'admin') );

drop policy if exists memberships_update on app.memberships;
create policy memberships_update on app.memberships
  for update
  using      ( app.has_role(company_id, 'owner', 'admin') )
  with check ( app.has_role(company_id, 'owner', 'admin') );

drop policy if exists memberships_delete on app.memberships;
create policy memberships_delete on app.memberships
  for delete using ( app.has_role(company_id, 'owner', 'admin') );

-- A company must never be left without an owner. Enforced as a trigger
-- because a policy cannot see the state of the rest of the table.
create or replace function app.memberships_keep_an_owner()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_company uuid; v_owners int;
begin
  v_company := coalesce(old.company_id, new.company_id);
  select count(*) into v_owners
  from app.memberships m
  where m.company_id = v_company and m.role = 'owner'
    and m.id <> coalesce(old.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;

  if v_owners = 0 then
    raise exception 'a company must keep at least one owner'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists memberships_owner_guard on app.memberships;
create trigger memberships_owner_guard
  before update or delete on app.memberships
  for each row when (coalesce(old.role, 'requester') = 'owner')
  execute function app.memberships_keep_an_owner();

-- ------------------------------------------------------------- grants ------
-- Supabase roles. RLS does the deciding; these just open the door.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema app to authenticated, anon;
grant select, insert, update, delete on all tables in schema app to authenticated;
grant execute on all functions in schema app to authenticated, anon;

alter default privileges in schema app
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema app
  grant execute on functions to authenticated, anon;
