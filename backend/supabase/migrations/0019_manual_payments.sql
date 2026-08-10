-- ============================================================================
-- 0019_manual_payments.sql
-- Paying by bank transfer, with a receipt.
--
-- This is how most Nigerian B2B actually pays, and it works while a Paystack
-- business account is still in approval. A company sees the account details,
-- transfers, uploads the receipt, and somebody at our end confirms it.
--
-- That last step is the awkward part, and it is worth being explicit about.
--
-- Everything else in this system is tenant-scoped: a query returns rows from
-- one company because the database will not return any others. Verifying a
-- payment is inherently cross-tenant — the person confirming it works for us,
-- not for the customer.
--
-- So rather than a superuser role that can see everything, there is a platform
-- reviewer who can see exactly one thing: payment submissions, with the company
-- name, the amount, the reference and the receipt. Not the register, not the
-- audit log, not assets, not people. The tenant isolation guarantee we make on
-- the security page stays true, because the exception is one table wide and is
-- itself audited.
-- ============================================================================

-- ------------------------------------------------------ where to transfer ---
-- Our own bank details, not a customer's. One row, editable only by a platform
-- reviewer, so a change is deliberate and recorded.
create table if not exists app.platform_settings (
  id            int primary key default 1 check (id = 1),
  bank_name     text,
  account_name  text,
  account_number text,
  instructions  text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references app.profiles(id)
);

insert into app.platform_settings (id, bank_name, account_name, account_number, instructions)
values (1, 'Not configured yet', 'Not configured yet', '',
        'Bank details have not been set up. Email hello@nothingmissing.ng and we will invoice you directly.')
on conflict (id) do nothing;

alter table app.platform_settings enable row level security;
alter table app.platform_settings force row level security;

-- Readable by anyone signed in: a customer needs to know where to send money.
-- There is nothing sensitive in an account number you are inviting people to
-- pay into.
drop policy if exists platform_settings_select on app.platform_settings;
create policy platform_settings_select on app.platform_settings
  for select using ( auth.uid() is not null );

revoke insert, update, delete on app.platform_settings from authenticated, anon;

-- ---------------------------------------------------- platform reviewers ---
-- Deliberately not a role in app.role_type. Company roles describe a position
-- inside one tenant; this describes a position at the vendor, and conflating
-- the two is how an "admin" flag quietly becomes a key to everything.
create table if not exists app.platform_reviewers (
  user_id    uuid primary key references app.profiles(id) on delete cascade,
  added_at   timestamptz not null default now(),
  added_by   uuid references app.profiles(id),
  note       text
);

alter table app.platform_reviewers enable row level security;
alter table app.platform_reviewers force row level security;

drop policy if exists reviewers_select on app.platform_reviewers;
create policy reviewers_select on app.platform_reviewers
  for select using ( user_id = auth.uid() );

revoke insert, update, delete on app.platform_reviewers from authenticated, anon;

create or replace function app.is_platform_reviewer()
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (select 1 from app.platform_reviewers where user_id = auth.uid())
$$;

-- -------------------------------------------------- payment submissions ----
do $$ begin
  create type app.transfer_proof_status as enum
    ('submitted','verified','rejected','superseded');
exception when duplicate_object then null; end $$;

create table if not exists app.payment_proofs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  payment_id    uuid references app.payments(id) on delete set null,
  reference     text not null,
  amount_minor  bigint not null check (amount_minor > 0),
  -- What the customer says they did. Never trusted as fact — the point of the
  -- receipt is that somebody checks.
  paid_on       date not null,
  bank_used     text,
  sender_name   text,
  narration     text,
  receipt_path  text,                  -- key in storage, never a public URL
  receipt_name  text,
  status        app.transfer_proof_status not null default 'submitted',
  submitted_by  uuid references app.profiles(id),
  submitted_label text not null,
  submitted_at  timestamptz not null default now(),
  reviewed_by   uuid references app.profiles(id),
  reviewed_label text,
  reviewed_at   timestamptz,
  review_note   text
);

create index if not exists proofs_pending_idx
  on app.payment_proofs (submitted_at) where status = 'submitted';
create index if not exists proofs_company_idx
  on app.payment_proofs (company_id, submitted_at desc);

alter table app.payment_proofs enable row level security;
alter table app.payment_proofs force row level security;

-- A company sees its own. A platform reviewer sees all of them — and this is
-- the only table in the schema where that is true.
drop policy if exists proofs_select on app.payment_proofs;
create policy proofs_select on app.payment_proofs
  for select using (
    app.has_role(company_id, 'owner', 'admin') or app.is_platform_reviewer()
  );

revoke insert, update, delete on app.payment_proofs from authenticated, anon;

-- ========================================================= submitting ======
create or replace function app.submit_payment_proof(
  p_company   uuid,
  p_amount    bigint,
  p_paid_on   date,
  p_bank      text default null,
  p_sender    text default null,
  p_narration text default null,
  p_receipt_path text default null,
  p_receipt_name text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_ref   text;
  v_id    uuid;
  v_label text;
  v_open  int;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can record a payment.' using errcode = '42501';
  end if;
  if p_amount <= 0 then
    raise exception 'Enter the amount you transferred.' using errcode = 'check_violation';
  end if;
  if p_paid_on > current_date then
    raise exception 'That date is in the future.' using errcode = 'check_violation';
  end if;
  if p_paid_on < current_date - 90 then
    raise exception 'That transfer is more than 90 days old. Email us instead so we can look it up.'
      using errcode = 'check_violation';
  end if;

  -- One open submission at a time. Three pending receipts for the same
  -- transfer is how a company gets credited twice.
  select count(*) into v_open from app.payment_proofs
   where company_id = p_company and status = 'submitted';
  if v_open >= 3 then
    raise exception 'You already have % payments awaiting confirmation. Give us a moment to check them.', v_open
      using errcode = 'check_violation';
  end if;

  select coalesce(full_name, email::text, 'Unknown') into v_label
    from app.profiles where id = auth.uid();

  v_ref := 'TRF-' || to_char(now(), 'YYYYMMDD') || '-' ||
           substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into app.payment_proofs
    (company_id, reference, amount_minor, paid_on, bank_used, sender_name,
     narration, receipt_path, receipt_name, submitted_by, submitted_label)
  values
    (p_company, v_ref, p_amount, p_paid_on, p_bank, p_sender,
     p_narration, p_receipt_path, p_receipt_name, auth.uid(), v_label)
  returning id into v_id;

  perform app.log(p_company, 'recorded a bank transfer', 'payment_proofs', v_id::text,
    v_ref, format('NGN %s, paid %s — awaiting confirmation', p_amount / 100, p_paid_on),
    'info');

  return jsonb_build_object('id', v_id, 'reference', v_ref, 'status', 'submitted');
end $$;

grant execute on function app.submit_payment_proof(uuid, bigint, date, text, text, text, text, text)
  to authenticated;

-- ========================================================== verifying ======
-- Confirming a transfer credits the company. It is the one action in the
-- system a person outside the company can take that changes something inside
-- it, so it writes an audit row into that company's log naming the reviewer.
create or replace function app.verify_payment_proof(
  p_id uuid, p_approve boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_p app.payment_proofs%rowtype;
  v_label text;
  v_end date;
begin
  if not app.is_platform_reviewer() then
    raise exception 'Only a Nothing Missing reviewer can confirm a transfer.'
      using errcode = '42501';
  end if;

  select * into v_p from app.payment_proofs where id = p_id for update;
  if not found then
    raise exception 'No such submission.' using errcode = 'no_data_found';
  end if;
  if v_p.status <> 'submitted' then
    raise exception 'This one has already been %.', v_p.status using errcode = 'check_violation';
  end if;

  select coalesce(full_name, email::text, 'Reviewer') into v_label
    from app.profiles where id = auth.uid();

  update app.payment_proofs
     set status = (case when p_approve then 'verified' else 'rejected' end)::app.transfer_proof_status,
         reviewed_by = auth.uid(), reviewed_label = v_label,
         reviewed_at = now(), review_note = p_note
   where id = p_id;

  if not p_approve then
    perform app.log(v_p.company_id, 'a recorded transfer was not confirmed',
      'payment_proofs', p_id::text, v_p.reference,
      coalesce(p_note, 'No reason given') || format(' — reviewed by %s', v_label), 'warn');
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  v_end := greatest(current_date, coalesce(
    (select current_period_end from app.subscriptions where company_id = v_p.company_id),
    current_date)) + interval '1 month';

  insert into app.payments
    (company_id, reference, amount_minor, status, channel, paid_at,
     period_start, period_end)
  values
    (v_p.company_id, v_p.reference, v_p.amount_minor, 'succeeded', 'bank transfer',
     v_p.paid_on::timestamptz, current_date, v_end)
  on conflict (company_id, reference) do nothing;

  update app.subscriptions
     set status = 'active', tier = 'standard',
         current_period_end = v_end, updated_at = now()
   where company_id = v_p.company_id;

  insert into app.billing_events (company_id, kind, amount_minor, reference)
  values (v_p.company_id, 'bank transfer confirmed', v_p.amount_minor, v_p.reference);

  -- Into the customer's own audit log, naming the outsider who did it. If we
  -- can reach into a company, the company gets to see that we did.
  perform app.log(v_p.company_id, 'a transfer was confirmed', 'payment_proofs',
    p_id::text, v_p.reference,
    format('NGN %s confirmed by %s at Nothing Missing — paid up to %s',
           v_p.amount_minor / 100, v_label, v_end),
    'ok');

  return jsonb_build_object('ok', true, 'status', 'verified', 'paid_until', v_end);
end $$;

grant execute on function app.verify_payment_proof(uuid, boolean, text) to authenticated;

-- What a reviewer sees: enough to check a receipt, and nothing else. No
-- register, no people, no audit trail — just the company name, so they know
-- whose transfer they are looking at.
create or replace function app.pending_payment_proofs()
returns table (
  id uuid, reference text, company_name text, company_slug text,
  amount_minor bigint, paid_on date, bank_used text, sender_name text,
  narration text, receipt_path text, receipt_name text,
  submitted_label text, submitted_at timestamptz, assets int
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select p.id, p.reference, c.name, c.slug, p.amount_minor, p.paid_on,
         p.bank_used, p.sender_name, p.narration, p.receipt_path, p.receipt_name,
         p.submitted_label, p.submitted_at,
         (select count(*)::int from app.assets a
          where a.company_id = p.company_id and a.status <> 'retired')
  from app.payment_proofs p
  join app.companies c on c.id = p.company_id
  where p.status = 'submitted' and app.is_platform_reviewer()
  order by p.submitted_at
$$;

grant execute on function app.pending_payment_proofs() to authenticated;

create or replace function app.update_platform_settings(
  p_bank text, p_account_name text, p_account_number text, p_instructions text
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if not app.is_platform_reviewer() then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update app.platform_settings
     set bank_name = p_bank, account_name = p_account_name,
         account_number = p_account_number, instructions = p_instructions,
         updated_at = now(), updated_by = auth.uid()
   where id = 1;
end $$;

grant execute on function app.update_platform_settings(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Making somebody a reviewer is a manual database action on purpose. There is
-- no screen for it, because a screen for granting cross-tenant visibility is a
-- screen somebody eventually clicks by mistake.
--
--   insert into app.platform_reviewers (user_id, note)
--   values ('<uuid from Authentication → Users>', 'Founder');
-- ---------------------------------------------------------------------------
