-- ============================================================================
-- 0027_profiles_and_access.sql
-- Letting people edit their own name, and making invitations visible.
--
-- Two gaps found by trying to use the system as a new company rather than as
-- its author.
--
-- 1. A DISPLAYED NAME COULD NOT BE CHANGED. It came from auth.users metadata,
--    written once at sign-up and editable nowhere in the application. Somebody
--    who signed up as "Test" or with a typo was stuck with it on every audit
--    row and every waybill they issued. app.profiles.full_name existed but
--    nothing wrote to it after the trigger.
--
-- 2. INVITATIONS EXISTED BUT WERE INVISIBLE. 0014 built invite_member(),
--    accept_invitation() and the /join page, and they work — but the People
--    page never called any of them. So the only way to get a second person in
--    was to write SQL, which means in practice nobody else ever logged in.
--    A feature nothing reaches is a feature that does not exist.
-- ============================================================================

-- ---------------------------------------------------- editing your name ----
-- The profile is the source of truth for display, not auth metadata. Audit
-- rows already store actor_label as text at the moment they were written, so
-- correcting a name today does not rewrite history — which is right: the log
-- should say who did it under the name they held then.
create or replace function app.update_my_profile(
  p_full_name text,
  p_phone     text default null,
  p_job_title text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_full_name, ''))) < 2 then
    raise exception 'Give a name of at least two characters.' using errcode = 'check_violation';
  end if;

  update app.profiles
     set full_name = btrim(p_full_name),
         phone     = nullif(btrim(coalesce(p_phone, '')), ''),
         job_title = nullif(btrim(coalesce(p_job_title, '')), '')
   where id = v_user;

  return jsonb_build_object('ok', true, 'full_name', btrim(p_full_name));
end $$;

-- Columns the profile did not have.
alter table app.profiles
  add column if not exists phone text,
  add column if not exists job_title text;

grant execute on function app.update_my_profile(text, text, text) to authenticated;

-- Own profile, editable by its owner and nobody else. An admin can read names
-- of people in their company — they already can through memberships — but
-- cannot rewrite somebody's name for them.
drop policy if exists profiles_update_self on app.profiles;
create policy profiles_update_self on app.profiles
  for update
  using      ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- --------------------------------------------------- invitations, visible --
-- What the People page needs: who has been invited, whether they accepted, and
-- whether the invitation is still usable. Open invitations that nobody chased
-- are a common reason a company thinks the product does not work.
create or replace function app.company_invitations(p_company uuid)
returns table (
  id uuid, email text, role text, location text,
  invited_by text, expires_on date, days_left int,
  accepted_at timestamptz, state text
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select
    i.id,
    i.email::text,
    i.role::text,
    l.name,
    coalesce(p.full_name, p.email::text),
    i.expires_on,
    (i.expires_on - current_date)::int,
    i.accepted_at,
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'withdrawn'
      when i.expires_on < current_date then 'expired'
      when i.expires_on - current_date <= 3 then 'expiring'
      else 'waiting'
    end
  from app.invitations i
  left join app.locations l on l.id = i.location_id
  left join app.profiles p on p.id = i.invited_by
  where i.company_id = p_company
    and app.has_role(p_company, 'owner', 'admin')
  order by
    case when i.accepted_at is null and i.revoked_at is null then 0 else 1 end,
    i.created_at desc
$$;

grant execute on function app.company_invitations(uuid) to authenticated;

-- Re-sending is issuing a fresh token, not resurrecting the old one. A token
-- somebody may have forwarded should not come back to life because the sender
-- clicked "resend".
create or replace function app.resend_invitation(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.invitations%rowtype;
begin
  select * into v_i from app.invitations where id = p_id;
  if not found then
    raise exception 'No such invitation.' using errcode = 'no_data_found';
  end if;
  if v_i.accepted_at is not null then
    raise exception 'That invitation was already accepted.' using errcode = 'check_violation';
  end if;
  if not app.has_role(v_i.company_id, 'owner', 'admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  -- Withdraw the old one first, so the previous link stops working.
  update app.invitations set revoked_at = now() where id = p_id;

  return app.invite_member(v_i.company_id, v_i.email::text, v_i.role, v_i.location_id);
end $$;

grant execute on function app.resend_invitation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Renaming a company. A test company becoming a real one is the first thing
-- anybody does, and the slug deliberately cannot change — every field link
-- already shared and every waybill already printed carries it.
--
-- The display name can change freely, which is what people actually mean.
-- ---------------------------------------------------------------------------
create or replace function app.rename_company(p_company uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_old text;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can rename the company.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'Give the company a name.' using errcode = 'check_violation';
  end if;

  select name into v_old from app.companies where id = p_company;
  update app.companies set name = btrim(p_name), updated_at = now() where id = p_company;

  perform app.log(p_company, 'renamed the company', 'companies', p_company::text,
    btrim(p_name), format('was %s', v_old), 'info');

  return jsonb_build_object('ok', true, 'name', btrim(p_name), 'was', v_old);
end $$;

grant execute on function app.rename_company(uuid, text) to authenticated;
