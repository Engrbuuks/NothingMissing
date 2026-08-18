-- ============================================================================
-- 0021_free_accounts.sql
-- Turning billing off, and creating companies by hand.
--
-- Two things, both of which exist because charging before anyone has told you
-- the price is right is backwards.
--
-- BILLING ENABLED is a single switch. With it off, every company is on a plan
-- that costs nothing, the billing screens say so plainly, and nothing is ever
-- restricted. It is not a discount applied to each company — it is the whole
-- system saying "not yet", which is honest and is also one row to change when
-- that stops being true.
--
-- COMPED accounts survive the switch being turned back on. An early customer
-- who was promised free access should not discover an invoice the day billing
-- starts, so the exemption is recorded against the company with a reason and
-- an expiry, rather than being an absence of a subscription row.
--
-- PROVISIONING creates a company for somebody who has not signed up. It exists
-- because the first ten customers are onboarded in a conversation, not through
-- a form — and doing that by hand in SQL is how a company ends up without an
-- owner, without a virtual warehouse, or with a slug somebody else wanted.
-- ============================================================================

-- ------------------------------------------------------- the big switch ----
alter table app.platform_settings
  add column if not exists billing_enabled boolean not null default false,
  add column if not exists free_notice text
    default 'Nothing Missing is free while we work with our first customers. You will be told well before that changes, and never charged without agreeing a price first.';

-- Default false, deliberately. A billing system that is on by default is one
-- that charges somebody during a trial by accident.

create or replace function app.billing_is_live()
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select coalesce((select billing_enabled from app.platform_settings where id = 1), false)
$$;

grant execute on function app.billing_is_live() to authenticated;

create or replace function app.set_billing_enabled(p_on boolean, p_notice text default null)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if not app.is_platform_reviewer() then
    raise exception 'Only a Nothing Missing reviewer can change this.' using errcode = '42501';
  end if;
  update app.platform_settings
     set billing_enabled = p_on,
         free_notice = coalesce(p_notice, free_notice),
         updated_at = now(), updated_by = auth.uid()
   where id = 1;
end $$;

grant execute on function app.set_billing_enabled(boolean, text) to authenticated;

-- ---------------------------------------------------------- comped ---------
alter table app.subscriptions
  add column if not exists comped boolean not null default false,
  add column if not exists comped_reason text,
  add column if not exists comped_until date,
  add column if not exists comped_by uuid references app.profiles(id);

create or replace function app.set_comped(
  p_company uuid, p_on boolean, p_reason text default null, p_until date default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_name text;
begin
  if not app.is_platform_reviewer() then
    raise exception 'Only a Nothing Missing reviewer can do this.' using errcode = '42501';
  end if;

  select name into v_name from app.companies where id = p_company;
  if v_name is null then
    raise exception 'No such company.' using errcode = 'no_data_found';
  end if;

  insert into app.subscriptions (company_id) values (p_company)
  on conflict (company_id) do nothing;

  update app.subscriptions
     set comped = p_on,
         comped_reason = case when p_on then p_reason else null end,
         comped_until = case when p_on then p_until else null end,
         comped_by = case when p_on then auth.uid() else null end,
         status = case when p_on then 'active'::app.sub_status else status end,
         updated_at = now()
   where company_id = p_company;

  -- Into the company's own log. If we change what somebody pays, they see it.
  perform app.log(p_company,
    case when p_on then 'free access granted' else 'free access ended' end,
    'subscriptions', p_company::text, null,
    case when p_on
      then coalesce(p_reason, 'No reason recorded')
           || coalesce(', until ' || p_until::text, ', with no end date')
      else 'This company will be billed normally from now on' end,
    case when p_on then 'ok' else 'warn' end);

  return jsonb_build_object('company', v_name, 'comped', p_on);
end $$;

grant execute on function app.set_comped(uuid, boolean, text, date) to authenticated;

-- billing_summary now answers three questions rather than one: what would this
-- cost, is anything actually being charged, and why not.
create or replace function app.billing_summary(p_company uuid)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_s app.subscriptions%rowtype;
  v_assets int;
  v_rate int := 18000;
  v_free int := 50;
  v_live boolean;
  v_would bigint;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'Only an owner or admin can see billing.' using errcode = '42501';
  end if;

  select count(*) into v_assets from app.assets
   where company_id = p_company and status <> 'retired';

  select * into v_s from app.subscriptions where company_id = p_company;
  if not found then
    insert into app.subscriptions (company_id) values (p_company)
    on conflict (company_id) do nothing;
    select * into v_s from app.subscriptions where company_id = p_company;
  end if;

  v_live := app.billing_is_live();
  v_would := case when v_assets <= v_free then 0 else v_assets * v_rate end;

  return jsonb_build_object(
    'tier', v_s.tier,
    'status', v_s.status,
    'assets', v_assets,
    'free_allowance', v_free,
    'rate_minor', v_rate,
    -- what it WOULD cost, always computed so nobody is surprised later
    'would_cost_minor', v_would,
    -- what is actually owed right now, which is the number that matters
    'monthly_minor', case
      when not v_live then 0
      when v_s.comped and (v_s.comped_until is null or v_s.comped_until >= current_date) then 0
      else v_would end,
    'billing_live', v_live,
    'comped', v_s.comped and (v_s.comped_until is null or v_s.comped_until >= current_date),
    'comped_reason', v_s.comped_reason,
    'comped_until', v_s.comped_until,
    'free_notice', (select free_notice from app.platform_settings where id = 1),
    'over_free_limit', (v_assets > v_free),
    'trial_ends_on', v_s.trial_ends_on,
    'current_period_end', v_s.current_period_end);
end $$;

-- Starting a payment must refuse while billing is off. Otherwise a company on
-- a free plan can be charged by pasting a URL, which is exactly the kind of
-- thing nobody notices until it happens.
create or replace function app.begin_payment(p_company uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_sum jsonb; v_ref text; v_amount bigint; v_email text;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'Only an owner or admin can start a payment.' using errcode = '42501';
  end if;

  if not app.billing_is_live() then
    raise exception 'Nothing Missing is free at the moment — there is nothing to pay.'
      using errcode = 'check_violation';
  end if;

  v_sum := app.billing_summary(p_company);
  v_amount := (v_sum ->> 'monthly_minor')::bigint;

  if v_amount <= 0 then
    raise exception 'There is nothing to pay on this account.'
      using errcode = 'check_violation';
  end if;

  select coalesce(email::text, '') into v_email from app.profiles where id = auth.uid();
  v_ref := 'NM-' || to_char(now(), 'YYYYMMDD') || '-' ||
           substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);

  insert into app.payments
    (company_id, reference, amount_minor, assets_billed, period_start, period_end, status)
  values
    (p_company, v_ref, v_amount, (v_sum ->> 'assets')::int,
     current_date, current_date + interval '1 month', 'pending');

  return jsonb_build_object('reference', v_ref, 'amount_minor', v_amount,
                            'email', v_email, 'assets', (v_sum ->> 'assets')::int);
end $$;

-- ====================================================== provisioning ========
-- Creating a company for somebody who has not signed up.
--
-- The account is created first in Supabase Auth (dashboard, or the admin API),
-- and this turns that person into the owner of a working company. It does the
-- same four things signup_company does — profile, company, owner membership,
-- virtual warehouse — but for a user who is not the caller, which is why it is
-- restricted to a platform reviewer.
create or replace function app.provision_company(
  p_owner_email text,
  p_owner_name  text,
  p_company_name text,
  p_slug        text default null,
  p_comp        boolean default true,
  p_comp_reason text default 'Early customer',
  p_registration text default null,
  p_address     text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_user uuid;
  v_company uuid;
  v_slug text;
  v_check jsonb;
begin
  if not app.is_platform_reviewer() then
    raise exception 'Only a Nothing Missing reviewer can provision a company.'
      using errcode = '42501';
  end if;

  p_owner_email := lower(btrim(p_owner_email));

  -- The auth user has to exist first. Creating one from here is not possible —
  -- passwords and confirmation emails are Supabase Auth's job, and duplicating
  -- that would mean storing a credential we have no business holding.
  begin
    select id into v_user from auth.users where lower(email) = p_owner_email;
  exception when others then
    v_user := null;
  end;

  if v_user is null then
    raise exception 'No account exists for %. Create it first in Authentication → Users, then run this again.', p_owner_email
      using errcode = 'no_data_found',
            hint = 'Tick "Auto Confirm User" so they can sign in without waiting for an email.';
  end if;

  insert into app.profiles (id, email, full_name)
  values (v_user, p_owner_email, p_owner_name)
  on conflict (id) do update
    set full_name = coalesce(nullif(btrim(p_owner_name), ''), app.profiles.full_name);

  v_slug := lower(btrim(coalesce(nullif(p_slug, ''), app.suggest_slug(p_company_name))));
  v_check := app.slug_available(v_slug);
  if not (v_check ->> 'available')::boolean then
    raise exception '%', v_check ->> 'reason' using errcode = 'check_violation';
  end if;

  insert into app.companies (name, registration_no, address, slug)
  values (btrim(p_company_name), nullif(btrim(coalesce(p_registration,'')),''),
          nullif(btrim(coalesce(p_address,'')),''), v_slug)
  returning id into v_company;

  insert into app.memberships (company_id, user_id, location_id, role)
  values (v_company, v_user, null, 'owner');

  insert into app.locations (company_id, name, kind, city, colour_hex)
  values (v_company, 'Virtual warehouse', 'virtual', 'No physical site', '#9296AC');

  if p_comp then
    insert into app.subscriptions (company_id) values (v_company)
    on conflict (company_id) do nothing;
    update app.subscriptions
       set comped = true, comped_reason = p_comp_reason,
           comped_by = auth.uid(), status = 'active', updated_at = now()
     where company_id = v_company;
  end if;

  perform app.log(v_company, 'company created by Nothing Missing', 'companies',
    v_company::text, v_slug,
    format('Set up for %s%s', p_owner_email,
      case when p_comp then ' with free access — ' || p_comp_reason else '' end),
    'ok');

  return jsonb_build_object(
    'company_id', v_company,
    'slug', v_slug,
    'url', format('https://%s.nothingmissing.ng', v_slug),
    'owner', p_owner_email,
    'comped', p_comp);
end $$;

grant execute on function app.provision_company(text, text, text, text, boolean, text, text, text)
  to authenticated;

-- Every company at a glance, for the reviewer screen. Deliberately narrow: the
-- name, when it started, how many assets, and what it pays. Not the register.
create or replace function app.platform_companies()
returns table (
  id uuid, name text, slug text, created_at timestamptz,
  assets int, people int, tier text, comped boolean,
  comped_reason text, last_activity timestamptz, archived boolean
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select c.id, c.name, c.slug, c.created_at,
         (select count(*)::int from app.assets a
          where a.company_id = c.id and a.status <> 'retired'),
         (select count(distinct m.user_id)::int from app.memberships m where m.company_id = c.id),
         coalesce(s.tier::text, 'starter'),
         coalesce(s.comped, false),
         s.comped_reason,
         (select max(e.occurred_at) from app.audit_events e where e.company_id = c.id),
         (c.archived_at is not null)
  from app.companies c
  left join app.subscriptions s on s.company_id = c.id
  where app.is_platform_reviewer()
  order by c.created_at desc
$$;

grant execute on function app.platform_companies() to authenticated;
