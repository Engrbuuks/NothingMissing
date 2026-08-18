-- ============================================================================
-- 0016_documents_billing.sql
-- Attachments, waybill documents, subscriptions, and recorded consent.
--
-- Three things here, each with a decision worth stating.
--
-- ATTACHMENTS are metadata rows only. The file itself lives in object storage;
-- this table records what it is, who uploaded it and what it belongs to. That
-- keeps the database small and, more usefully, means a leaked storage URL
-- reveals one file rather than a listing of everything a company owns.
--
-- WAYBILL DOCUMENTS are frozen. A waybill is a legal-ish artefact a driver
-- carries through checkpoints; if it re-renders from live data, the copy on
-- the wall stops matching the copy in the system the moment anything changes.
-- So issuing one snapshots the company details, the route, and every line, and
-- a revision creates a new number rather than editing the old one.
--
-- BILLING counts assets, because that is what the pricing says. The count is
-- computed from the register rather than stored, so it cannot drift from what
-- the customer can see on their own dashboard.
-- ============================================================================

-- ------------------------------------------------------------ attachments --
do $$ begin
  create type app.attachment_kind as enum
    ('photo','document','signature','delivery_note','invoice','report');
exception when duplicate_object then null; end $$;

create table if not exists app.attachments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  kind         app.attachment_kind not null default 'photo',
  -- what it is attached to. Exactly one of these is set.
  asset_id     uuid references app.assets(id) on delete cascade,
  transfer_id  uuid references app.transfers(id) on delete cascade,
  submission_id uuid references app.submissions(id) on delete cascade,
  maintenance_id uuid references app.maintenance_events(id) on delete cascade,
  discrepancy_id uuid references app.discrepancies(id) on delete cascade,

  storage_path text not null,          -- key in object storage, never a URL
  file_name    text not null,
  mime_type    text not null,
  bytes        bigint not null check (bytes > 0 and bytes <= 26214400),  -- 25 MB
  caption      text,
  uploaded_by  uuid references app.profiles(id),
  uploaded_label text not null,        -- survives a deleted profile
  created_at   timestamptz not null default now(),

  constraint attachment_has_one_parent check (
    (asset_id is not null)::int + (transfer_id is not null)::int +
    (submission_id is not null)::int + (maintenance_id is not null)::int +
    (discrepancy_id is not null)::int = 1
  ),
  -- Only formats a phone actually produces and a browser can render. An
  -- allow-list rather than a block-list: the interesting attacks are always
  -- the format nobody thought of.
  constraint attachment_mime_ck check (
    mime_type in ('image/jpeg','image/png','image/webp','image/heic','application/pdf')
  )
);

create index if not exists attachments_asset_idx on app.attachments (asset_id);
create index if not exists attachments_transfer_idx on app.attachments (transfer_id);
create index if not exists attachments_submission_idx on app.attachments (submission_id);
create unique index if not exists attachments_path_uq on app.attachments (storage_path);

alter table app.attachments enable row level security;
alter table app.attachments force row level security;

drop policy if exists attachments_select on app.attachments;
create policy attachments_select on app.attachments
  for select using ( app.is_member(company_id) );

drop policy if exists attachments_insert on app.attachments;
create policy attachments_insert on app.attachments
  for insert with check ( app.can_write(company_id) );

drop policy if exists attachments_delete on app.attachments;
create policy attachments_delete on app.attachments
  for delete using ( app.has_role(company_id, 'owner','admin') );

-- Storage keys are namespaced by company, so a bucket policy can enforce the
-- same separation the database does. Two layers, same rule.
create or replace function app.attachment_path(p_company uuid, p_file text)
returns text
language sql stable as $$
  select format('%s/%s-%s',
    p_company::text,
    to_char(now(), 'YYYYMMDDHH24MISS'),
    regexp_replace(coalesce(p_file, 'file'), '[^a-zA-Z0-9._-]+', '-', 'g'))
$$;

-- ------------------------------------------------------ waybill snapshot ---
create table if not exists app.waybill_documents (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  transfer_id  uuid not null references app.transfers(id) on delete cascade,
  waybill_no   text not null,
  revision     int  not null default 1,
  -- The whole document as it was at issue: company details, route, driver,
  -- every line. A later rename of a location does not rewrite history.
  snapshot     jsonb not null,
  issued_at    timestamptz not null default now(),
  issued_by    uuid references app.profiles(id),
  issued_label text not null,
  unique (company_id, waybill_no, revision)
);

alter table app.waybill_documents enable row level security;
alter table app.waybill_documents force row level security;

drop policy if exists waybills_select on app.waybill_documents;
create policy waybills_select on app.waybill_documents
  for select using ( app.is_member(company_id) );

revoke insert, update, delete on app.waybill_documents from authenticated, anon;

create or replace function app.issue_waybill_document(p_transfer uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t app.transfers%rowtype;
  v_c app.companies%rowtype;
  v_snap jsonb;
  v_rev int;
  v_label text;
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
      'address', v_c.address, 'phone', v_c.phone, 'brand_hex', v_c.brand_hex),
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

grant execute on function app.issue_waybill_document(uuid) to authenticated;

-- ------------------------------------------------------------- billing -----
do $$ begin
  create type app.plan_tier as enum ('starter','standard','enterprise');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.sub_status as enum ('trialing','active','past_due','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists app.subscriptions (
  company_id     uuid primary key references app.companies(id) on delete cascade,
  tier           app.plan_tier not null default 'starter',
  status         app.sub_status not null default 'trialing',
  trial_ends_on  date not null default (current_date + 30),
  -- Paystack's own identifiers, so a webhook can find the row.
  customer_code  text,
  subscription_code text,
  current_period_end date,
  updated_at     timestamptz not null default now()
);

create table if not exists app.billing_events (
  id          bigserial primary key,
  company_id  uuid not null references app.companies(id) on delete cascade,
  kind        text not null,
  amount_minor bigint,
  reference   text,
  payload     jsonb,
  at          timestamptz not null default now()
);

alter table app.subscriptions  enable row level security;
alter table app.billing_events enable row level security;
alter table app.subscriptions  force row level security;
alter table app.billing_events force row level security;

drop policy if exists subs_select on app.subscriptions;
create policy subs_select on app.subscriptions
  for select using ( app.has_role(company_id, 'owner','admin') );

drop policy if exists billing_select on app.billing_events;
create policy billing_select on app.billing_events
  for select using ( app.has_role(company_id, 'owner','admin') );

revoke insert, update, delete on app.subscriptions  from authenticated, anon;
revoke insert, update, delete on app.billing_events from authenticated, anon;

-- Starter is free up to 50 assets. Counted from the register rather than
-- stored, so the number on the billing page is the same number on the
-- dashboard and cannot drift from it.
create or replace function app.billing_summary(p_company uuid)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_s app.subscriptions%rowtype;
  v_assets int;
  v_rate   int := 18000;   -- kobo per asset per month
  v_free   int := 50;
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

  return jsonb_build_object(
    'tier', v_s.tier, 'status', v_s.status,
    'trial_ends_on', v_s.trial_ends_on,
    'assets', v_assets,
    'free_allowance', v_free,
    'billable', greatest(0, v_assets - case when v_s.tier = 'starter' then v_free else 0 end),
    'rate_minor', v_rate,
    'monthly_minor', case
      when v_s.tier = 'starter' and v_assets <= v_free then 0
      else v_assets * v_rate end,
    'over_free_limit', (v_s.tier = 'starter' and v_assets > v_free),
    'current_period_end', v_s.current_period_end);
end $$;

grant execute on function app.billing_summary(uuid) to authenticated;

create or replace function app.subscriptions_seed(p_company uuid)
returns void language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  insert into app.subscriptions (company_id) values (p_company)
  on conflict (company_id) do nothing;
end $$;

-- Same trap as the slug and notification backfills: a company created next
-- year needs one too, so it is a trigger rather than a one-off update.
create or replace function app.companies_seed_subscription()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  perform app.subscriptions_seed(new.id);
  return new;
end $$;

drop trigger if exists companies_subscription_guard on app.companies;
create trigger companies_subscription_guard
  after insert on app.companies
  for each row execute function app.companies_seed_subscription();

do $$
declare c record;
begin
  for c in select id from app.companies loop
    perform app.subscriptions_seed(c.id);
  end loop;
end $$;

-- ---------------------------------------------------------- consent --------
-- The NDPR expects a record of what someone agreed to and when. A boolean is
-- not a record: it cannot say which version of the terms was accepted, which
-- is the only thing that matters if it is ever disputed.
create table if not exists app.consents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app.profiles(id) on delete cascade,
  company_id uuid references app.companies(id) on delete set null,
  document   text not null check (document in ('terms','privacy','dpa')),
  version    text not null,
  accepted_at timestamptz not null default now(),
  ip_hash    text,
  unique (user_id, document, version)
);

alter table app.consents enable row level security;
alter table app.consents force row level security;

drop policy if exists consents_select on app.consents;
create policy consents_select on app.consents
  for select using ( user_id = auth.uid() or app.has_role(company_id, 'owner','admin') );

drop policy if exists consents_insert on app.consents;
create policy consents_insert on app.consents
  for insert with check ( user_id = auth.uid() );

revoke update, delete on app.consents from authenticated, anon;

-- A person can ask for everything held about them. Answering that by hand is
-- how a small company misses the deadline, so it is a function.
create or replace function app.export_my_data()
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'profile', (select to_jsonb(p) from app.profiles p where p.id = v_user),
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object(
        'company', c.name, 'role', m.role, 'since', m.created_at)), '[]'::jsonb)
      from app.memberships m join app.companies c on c.id = m.company_id
      where m.user_id = v_user),
    'consents', (select coalesce(jsonb_agg(jsonb_build_object(
        'document', document, 'version', version, 'accepted_at', accepted_at)), '[]'::jsonb)
      from app.consents where user_id = v_user),
    'actions_recorded', (select count(*) from app.audit_events where actor_id = v_user),
    'note', 'Actions you took are kept in each company''s audit log. Those records belong to the company and cannot be removed on request — they are the basis of its asset register.');
end $$;

grant execute on function app.export_my_data() to authenticated;
