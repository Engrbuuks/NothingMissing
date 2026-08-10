-- ============================================================================
-- 0014_signup.sql
-- Creating a company account, and letting other people in.
--
-- The loopholes this closes, each of which is a real way the system could be
-- abused or simply fail on day one:
--
--  1. A profile has to exist before create_company() works, but Supabase signup
--     only writes auth.users. Without a trigger, every single sign-up fails at
--     the last step with a foreign key error. Fixed by a trigger on auth.users.
--
--  2. Nothing stopped one account creating unlimited companies. A cap, and a
--     cooling-off window, so a script cannot mint a thousand tenants overnight.
--
--  3. Nothing stopped an unverified email owning a company. Sign-up is allowed,
--     but a company cannot be created until the address is confirmed — otherwise
--     anyone can squat a slug using an address they do not control.
--
--  4. Invitations were not modelled at all. They are now tokens, hashed, single
--     use, expiring, and bound to one email — so a forwarded invite does not let
--     a stranger into a company.
--
--  5. Nothing stopped an invite granting a role more senior than the inviter's.
--     An admin could invite an owner and then be removed by them.
--
--  6. The slug claim had a race: two sign-ups checking availability at the same
--     moment would both pass, then one would fail on the unique index with an
--     error nobody could act on. Now it retries and reports plainly.
-- ============================================================================

-- ------------------------------------------------- profile from auth.users --
-- Runs as the definer with no RLS in the way, because at the moment it fires
-- there is no session at all — the user has signed up but not signed in.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  insert into app.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(app.profiles.full_name, excluded.full_name);
  return new;
end $$;

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'auth' and table_name = 'users') then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created
             after insert on auth.users
             for each row execute function app.handle_new_auth_user()';
    -- Email confirmation arrives as an update, not an insert.
    execute 'drop trigger if exists on_auth_user_updated on auth.users';
    execute 'create trigger on_auth_user_updated
             after update of email, raw_user_meta_data on auth.users
             for each row execute function app.handle_new_auth_user()';
  end if;
end $$;

-- ------------------------------------------------------- abuse limiting -----
create table if not exists app.signup_events (
  id         bigserial primary key,
  user_id    uuid not null,
  kind       text not null check (kind in ('company_created','invite_sent')),
  at         timestamptz not null default now()
);

create index if not exists signup_events_user_idx on app.signup_events (user_id, at desc);

alter table app.signup_events enable row level security;
alter table app.signup_events force row level security;
revoke insert, update, delete on app.signup_events from authenticated, anon;

-- ---------------------------------------------------------- invitations -----
create table if not exists app.invitations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  email        citext not null,
  role         app.role_type not null,
  location_id  uuid references app.locations(id) on delete cascade,
  token_hash   text not null,
  invited_by   uuid references app.profiles(id),
  expires_on   date not null default (current_date + 14),
  accepted_at  timestamptz,
  accepted_by  uuid references app.profiles(id),
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

create unique index if not exists invitations_token_idx on app.invitations (token_hash);
create index if not exists invitations_open_idx on app.invitations (company_id)
  where accepted_at is null and revoked_at is null;

-- One open invitation per address per company. Sending three and having the
-- person accept the oldest is how someone ends up with the wrong role.
create unique index if not exists invitations_one_open_per_email
  on app.invitations (company_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table app.invitations enable row level security;
alter table app.invitations force row level security;

drop policy if exists invitations_select on app.invitations;
create policy invitations_select on app.invitations
  for select using ( app.has_role(company_id, 'owner', 'admin') );

revoke insert, update, delete on app.invitations from authenticated, anon;

-- ====================================================== creating a company ==
create or replace function app.signup_company(
  p_company_name text,
  p_slug         text default null,
  p_full_name    text default null,
  p_registration text default null,
  p_address      text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_user     uuid := auth.uid();
  v_email    text;
  v_verified boolean := true;
  v_slug     text;
  v_check    jsonb;
  v_company  uuid;
  v_recent   int;
  v_owned    int;
  v_try      int := 0;
begin
  if v_user is null then
    raise exception 'You need to be signed in to create a company.'
      using errcode = '42501';
  end if;

  -- Loophole 3: an unconfirmed address must not be able to own a company, or
  -- anyone can squat a slug using an address they do not control.
  begin
    select u.email, (u.email_confirmed_at is not null)
      into v_email, v_verified
    from auth.users u where u.id = v_user;
  exception when others then
    v_verified := true;   -- non-Supabase environment; the shim has no such column
  end;

  if not coalesce(v_verified, false) then
    raise exception 'Confirm your email address first — check your inbox for the link.'
      using errcode = 'check_violation';
  end if;

  -- The profile should exist from the auth trigger, but a project migrated
  -- from before it existed will not have one. Create it rather than failing.
  insert into app.profiles (id, email, full_name)
  values (v_user, coalesce(v_email, v_user::text || '@unknown'), p_full_name)
  on conflict (id) do update
    set full_name = coalesce(nullif(btrim(p_full_name), ''), app.profiles.full_name);

  -- Loophole 2: caps. Generous enough that a real person running several
  -- businesses is unaffected, tight enough that a script is not.
  select count(*) into v_owned
  from app.memberships m
  join app.companies c on c.id = m.company_id
  where m.user_id = v_user and m.role = 'owner' and c.archived_at is null;

  if v_owned >= 10 then
    raise exception 'This account already owns 10 companies. Contact support if you genuinely need more.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_recent
  from app.signup_events
  where user_id = v_user and kind = 'company_created' and at > now() - interval '1 hour';

  if v_recent >= 3 then
    raise exception 'Too many companies created in the last hour. Try again shortly.'
      using errcode = 'check_violation';
  end if;

  if length(btrim(coalesce(p_company_name, ''))) < 2 then
    raise exception 'Give the company a name.' using errcode = 'check_violation';
  end if;

  -- Loophole 6: two sign-ups can pass the availability check at the same
  -- instant and then collide on the unique index. Retry with a suffix rather
  -- than handing the second person a constraint error they cannot act on.
  v_slug := lower(btrim(coalesce(nullif(p_slug, ''), app.suggest_slug(p_company_name))));
  v_check := app.slug_available(v_slug);
  if not (v_check ->> 'available')::boolean then
    raise exception '%', v_check ->> 'reason' using errcode = 'check_violation';
  end if;

  loop
    begin
      insert into app.companies (name, registration_no, address, slug)
      values (btrim(p_company_name), nullif(btrim(coalesce(p_registration,'')),''),
              nullif(btrim(coalesce(p_address,'')),''), v_slug)
      returning id into v_company;
      exit;
    exception when unique_violation then
      v_try := v_try + 1;
      exit when v_try > 5;
      v_slug := app.suggest_slug(p_company_name);
    end;
  end loop;

  if v_company is null then
    raise exception 'That address was taken while you were signing up. Please pick another.'
      using errcode = 'unique_violation';
  end if;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_company, v_user, null, 'owner');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company, 'Virtual warehouse', 'virtual', 'No physical site', '#9296AC');

  insert into app.signup_events (user_id, kind) values (v_user, 'company_created');

  perform app.log(v_company, 'created the company', 'companies', v_company::text, v_slug,
    format('%s, at %s.nothingmissing.ng', btrim(p_company_name), v_slug), 'ok');

  return jsonb_build_object(
    'company_id', v_company,
    'slug', v_slug,
    'url', format('https://%s.nothingmissing.ng', v_slug));
end $$;

grant execute on function app.signup_company(text, text, text, text, text) to authenticated;

-- ========================================================== invitations =====
create or replace function app.invite_member(
  p_company  uuid,
  p_email    text,
  p_role     app.role_type,
  p_location uuid default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_token text;
  v_id    uuid;
  v_mine  app.role_type;
  v_sent  int;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can invite people.' using errcode = '42501';
  end if;

  -- Loophole 5: nobody invites someone more senior than themselves. An admin
  -- who could mint owners could be removed by the owner they just created.
  v_mine := app.role_in(p_company);
  if v_mine <> 'owner' and p_role = 'owner' then
    raise exception 'Only an owner can invite another owner.' using errcode = '42501';
  end if;

  p_email := lower(btrim(p_email));
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That does not look like an email address.' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from app.memberships m
    join app.profiles pr on pr.id = m.user_id
    where m.company_id = p_company and lower(pr.email::text) = p_email
  ) then
    raise exception 'That person is already a member of this company.'
      using errcode = 'unique_violation';
  end if;

  select count(*) into v_sent from app.signup_events
   where user_id = auth.uid() and kind = 'invite_sent' and at > now() - interval '1 hour';
  if v_sent >= 50 then
    raise exception 'Too many invitations in the last hour.' using errcode = 'check_violation';
  end if;

  if p_location is not null and not exists (
    select 1 from app.locations where id = p_location and company_id = p_company
  ) then
    raise exception 'That location is not in this company.' using errcode = 'foreign_key_violation';
  end if;

  -- Supersede any open invitation for this address rather than colliding.
  update app.invitations set revoked_at = now()
   where company_id = p_company and lower(email) = p_email
     and accepted_at is null and revoked_at is null;

  v_token := encode(gen_random_bytes(24), 'hex');

  insert into app.invitations (company_id, email, role, location_id, token_hash, invited_by)
  values (p_company, p_email, p_role, p_location,
          encode(digest(v_token, 'sha256'), 'hex'), auth.uid())
  returning id into v_id;

  insert into app.signup_events (user_id, kind) values (auth.uid(), 'invite_sent');

  perform app.log(p_company, 'invited someone', 'invitations', v_id::text, p_email,
    format('as %s%s', p_role,
      coalesce(' at ' || (select name from app.locations where id = p_location), ', all locations')),
    'info', p_location);

  return jsonb_build_object('invitation_id', v_id, 'token', v_token,
                            'path', format('/join/%s', v_token));
end $$;

-- What an invitation looks like to someone who has not signed in yet. Returns
-- the company name so the page can be branded, and nothing else.
create or replace function app.invitation_preview(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.invitations%rowtype; v_c text;
begin
  select * into v_i from app.invitations
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and accepted_at is null and revoked_at is null and expires_on >= current_date;
  if not found then
    return jsonb_build_object('valid', false);
  end if;
  select name into v_c from app.companies where id = v_i.company_id;
  return jsonb_build_object(
    'valid', true, 'company', v_c, 'email', v_i.email, 'role', v_i.role,
    'location', (select name from app.locations where id = v_i.location_id));
end $$;

create or replace function app.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_i    app.invitations%rowtype;
  v_user uuid := auth.uid();
  v_mail text;
  v_slug text;
begin
  if v_user is null then
    raise exception 'Sign in first, then open the invitation again.' using errcode = '42501';
  end if;

  select * into v_i from app.invitations
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
   for update;

  if not found then
    raise exception 'This invitation is not valid.' using errcode = 'no_data_found';
  end if;
  if v_i.accepted_at is not null then
    raise exception 'This invitation has already been used.' using errcode = 'check_violation';
  end if;
  if v_i.revoked_at is not null or v_i.expires_on < current_date then
    raise exception 'This invitation has expired. Ask for a new one.' using errcode = 'check_violation';
  end if;

  -- Loophole 4: bound to the address it was sent to. A forwarded invitation
  -- does not let a stranger into the company.
  select lower(email::text) into v_mail from app.profiles where id = v_user;
  if v_mail is distinct from lower(v_i.email::text) then
    raise exception 'This invitation was sent to %. Sign in with that address.', v_i.email
      using errcode = '42501';
  end if;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_i.company_id, v_user, v_i.location_id, v_i.role)
  on conflict do nothing;

  update app.invitations
     set accepted_at = now(), accepted_by = v_user
   where id = v_i.id;

  select slug into v_slug from app.companies where id = v_i.company_id;

  perform app.log(v_i.company_id, 'joined the company', 'memberships', v_user::text,
    v_i.email::text, format('accepted an invitation as %s', v_i.role), 'ok', v_i.location_id);

  return jsonb_build_object('company_id', v_i.company_id, 'slug', v_slug,
                            'url', format('https://%s.nothingmissing.ng', v_slug));
end $$;

create or replace function app.revoke_invitation(p_id uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.invitations%rowtype;
begin
  select * into v_i from app.invitations where id = p_id;
  if not found then return; end if;
  if not app.has_role(v_i.company_id, 'owner', 'admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update app.invitations set revoked_at = now() where id = p_id;
  perform app.log(v_i.company_id, 'revoked an invitation', 'invitations', p_id::text,
    v_i.email::text, 'No longer usable', 'warn');
end $$;

grant execute on function app.invite_member(uuid, text, app.role_type, uuid) to authenticated;
grant execute on function app.invitation_preview(text) to anon, authenticated;
grant execute on function app.accept_invitation(text) to authenticated;
grant execute on function app.revoke_invitation(uuid) to authenticated;
