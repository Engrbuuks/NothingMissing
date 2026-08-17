-- ============================================================================
-- 0030_landing.sql
-- Where somebody belongs after they authenticate.
--
-- Three bugs, all the same shape: the application knew how to authenticate
-- somebody but not where to put them afterwards.
--
-- 1. SIGNING IN ON THE APEX LANDED ON THE MARKETING SITE. Sign-in sent people
--    to '/', which on nothingmissing.ng has no tenant and redirects to /home.
--    So a signed-in owner was looking at a page inviting them to start free.
--    The app needs to look up which company they belong to and send them to
--    its subdomain.
--
-- 2. AN INVITED PERSON WAS OFFERED A NEW COMPANY. The join page said "create
--    an account", sign-up confirmed the address, and the callback sent them to
--    /onboarding — which asks them to name a company. Somebody invited to join
--    Zenith would have founded "Zenith 2" and wondered why it was empty.
--
-- 3. NOTHING KNEW A PENDING INVITATION EXISTED. There was no way to ask "does
--    this person have an invitation waiting", so no screen could route around
--    the problem.
--
-- The fix is one function that answers "where does this person go now", used
-- by sign-in, the auth callback and the apex root alike. One answer, one place.
-- ============================================================================

-- Does this person have an invitation waiting? Keyed on their address rather
-- than a token, so it works for somebody who has just confirmed their email
-- and no longer has the link to hand.
create or replace function app.my_pending_invitation()
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_email text;
  v_i     record;
begin
  if auth.uid() is null then
    return jsonb_build_object('found', false);
  end if;

  select lower(email::text) into v_email from app.profiles where id = auth.uid();
  if v_email is null then
    return jsonb_build_object('found', false);
  end if;

  select i.id, i.role, c.name as company, c.slug, l.name as location
    into v_i
  from app.invitations i
  join app.companies c on c.id = i.company_id
  left join app.locations l on l.id = i.location_id
  where lower(i.email::text) = v_email
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_on >= current_date
  order by i.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  -- Deliberately no token. Knowing an invitation exists is not the same as
  -- being able to use it — the token stays with the person it was emailed to.
  return jsonb_build_object(
    'found', true,
    'company', v_i.company,
    'slug', v_i.slug,
    'role', v_i.role,
    'location', v_i.location);
end $$;

grant execute on function app.my_pending_invitation() to authenticated;

-- Accepting by address rather than by token, for somebody who has confirmed
-- their email and come back without the original link. The address is the
-- thing the invitation was bound to, so this grants nothing the token would
-- not have — and it stops a confirmed invitee being stranded.
create or replace function app.accept_my_invitation()
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_email text;
  v_i     app.invitations%rowtype;
  v_slug  text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select lower(email::text) into v_email from app.profiles where id = auth.uid();

  select * into v_i from app.invitations
  where lower(email::text) = v_email
    and accepted_at is null and revoked_at is null
    and expires_on >= current_date
  order by created_at desc
  limit 1
  for update;

  if not found then
    raise exception 'You have no invitation waiting.' using errcode = 'no_data_found';
  end if;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_i.company_id, auth.uid(), v_i.location_id, v_i.role)
  on conflict do nothing;

  update app.invitations
     set accepted_at = now(), accepted_by = auth.uid()
   where id = v_i.id;

  select slug into v_slug from app.companies where id = v_i.company_id;

  perform app.log(v_i.company_id, 'joined the company', 'memberships', auth.uid()::text,
    v_i.email::text, format('accepted an invitation as %s', v_i.role), 'ok', v_i.location_id);

  return jsonb_build_object('company_id', v_i.company_id, 'slug', v_slug,
                            'url', format('https://%s.nothingmissing.ng', v_slug));
end $$;

grant execute on function app.accept_my_invitation() to authenticated;

-- ---------------------------------------------------------------------------
-- The single answer to "where does this person go now".
--
-- Used by sign-in, the auth callback and the apex root. Having three screens
-- each work it out separately is how one of them ends up on the marketing site.
-- ---------------------------------------------------------------------------
create or replace function app.where_do_i_go()
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_count int;
  v_slug  text;
  v_name  text;
  v_inv   jsonb;
begin
  if auth.uid() is null then
    return jsonb_build_object('destination', 'sign_in');
  end if;

  -- An invitation outranks everything. Somebody who was invited and then signs
  -- up is trying to join a company, not found one, and offering them
  -- onboarding first is how they end up with an empty company of their own.
  v_inv := app.my_pending_invitation();
  if (v_inv ->> 'found')::boolean then
    return jsonb_build_object(
      'destination', 'invitation',
      'company', v_inv ->> 'company',
      'role', v_inv ->> 'role');
  end if;

  select count(*) into v_count from app.memberships where user_id = auth.uid();

  if v_count = 0 then
    return jsonb_build_object('destination', 'onboarding');
  end if;

  if v_count = 1 then
    select c.slug, c.name into v_slug, v_name
    from app.memberships m
    join app.companies c on c.id = m.company_id
    where m.user_id = auth.uid()
    limit 1;
    return jsonb_build_object('destination', 'company', 'slug', v_slug, 'name', v_name);
  end if;

  -- More than one: they have to choose, because guessing wrong sends somebody
  -- to the register of a company they were not thinking about.
  return jsonb_build_object(
    'destination', 'choose',
    'companies', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'slug', c.slug, 'name', c.name, 'role', m.role) order by c.name), '[]'::jsonb)
      from app.memberships m
      join app.companies c on c.id = m.company_id
      where m.user_id = auth.uid() and c.archived_at is null));
end $$;

grant execute on function app.where_do_i_go() to authenticated;
