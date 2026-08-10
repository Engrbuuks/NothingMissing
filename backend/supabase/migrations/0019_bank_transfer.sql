-- ============================================================================
-- 0019_bank_transfer.sql
-- Paying by bank transfer, with a receipt.
--
-- The decision this file turns on: **a receipt is a claim, not a payment.**
--
-- If uploading an image activated a subscription, then a doctored image buys
-- service — and the first person to notice would be whoever reconciles the
-- bank statement at month end, by which point the account has been in use for
-- weeks. So an upload creates a claim in `submitted`, and nothing changes
-- until someone at Nothing Missing confirms it against the actual statement.
--
-- The second decision: the confirmation cannot be done by the customer. A
-- company owner confirming their own payment is not a control. That needs a
-- notion of platform staff, which does not otherwise exist in this schema —
-- every other table is scoped to a tenant, and deliberately so. `platform_admins`
-- is the one table that sits outside tenancy, and it is kept as small and as
-- obvious as possible for that reason.
-- ============================================================================

-- ------------------------------------------------------ platform staff -----
create table if not exists app.platform_admins (
  user_id    uuid primary key references app.profiles(id) on delete cascade,
  added_at   timestamptz not null default now(),
  note       text
);

alter table app.platform_admins enable row level security;
alter table app.platform_admins force row level security;

-- Nobody reads this list through the API, including the people on it. Knowing
-- who can confirm payments is not information a customer needs, and it is a
-- useful thing for an attacker to have.
drop policy if exists platform_admins_none on app.platform_admins;
create policy platform_admins_none on app.platform_admins for select using (false);
revoke select, insert, update, delete on app.platform_admins from authenticated, anon;

create or replace function app.is_platform_admin()
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select exists (select 1 from app.platform_admins where user_id = auth.uid())
$$;

grant execute on function app.is_platform_admin() to authenticated;

-- ------------------------------------------------- where the money goes ----
-- One row. Kept in the database rather than in environment variables so it can
-- be corrected without a deploy — a wrong account number is the kind of
-- mistake you want to fix in ninety seconds.
create table if not exists app.payout_account (
  id             int primary key default 1 check (id = 1),
  bank_name      text not null,
  account_name   text not null,
  account_number text not null,
  instructions   text,
  updated_at     timestamptz not null default now()
);

insert into app.payout_account (id, bank_name, account_name, account_number, instructions)
values (1, 'Not set yet', 'Not set yet', '0000000000',
        'Use your payment reference as the transfer narration so we can match it.')
on conflict (id) do nothing;

alter table app.payout_account enable row level security;
alter table app.payout_account force row level security;

-- Readable by any signed-in user: they need it to make the transfer. It is
-- printed on invoices anyway.
drop policy if exists payout_select on app.payout_account;
create policy payout_select on app.payout_account for select using ( auth.uid() is not null );
revoke insert, update, delete on app.payout_account from authenticated, anon;

-- ------------------------------------------------------------- claims ------
do $$ begin
  create type app.claim_status as enum ('submitted','confirmed','rejected','superseded');
exception when duplicate_object then null; end $$;

create table if not exists app.transfer_claims (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references app.companies(id) on delete cascade,
  payment_id     uuid references app.payments(id) on delete set null,
  reference      text not null,
  amount_minor   bigint not null check (amount_minor > 0),
  -- what the customer says they did
  paid_on        date not null,
  bank_from      text,
  narration      text,
  note           text,
  receipt_path   text,                       -- key in storage, never a URL
  receipt_name   text,
  receipt_mime   text check (receipt_mime is null or receipt_mime in
                   ('image/jpeg','image/png','image/webp','image/heic','application/pdf')),
  receipt_bytes  bigint check (receipt_bytes is null or
                   (receipt_bytes > 0 and receipt_bytes <= 10485760)),   -- 10 MB
  -- and what we found
  status         app.claim_status not null default 'submitted',
  submitted_by   uuid references app.profiles(id),
  submitted_label text not null,
  submitted_at   timestamptz not null default now(),
  reviewed_by    uuid references app.profiles(id),
  reviewed_label text,
  reviewed_at    timestamptz,
  review_note    text,
  -- what the statement actually showed, which may differ from the claim
  confirmed_amount_minor bigint,
  constraint claim_review_ck check (
    (status = 'submitted' and reviewed_at is null)
    or (status <> 'submitted' and reviewed_at is not null)
  )
);

create index if not exists claims_pending_idx
  on app.transfer_claims (submitted_at) where status = 'submitted';
create index if not exists claims_company_idx
  on app.transfer_claims (company_id, submitted_at desc);

alter table app.transfer_claims enable row level security;
alter table app.transfer_claims force row level security;

-- A company sees its own claims. Platform staff see all of them, which is the
-- only place in this schema anything crosses a tenant boundary — and it is why
-- platform_admins is a table of named people rather than a flag on a profile.
drop policy if exists claims_select on app.transfer_claims;
create policy claims_select on app.transfer_claims
  for select using ( app.is_member(company_id) or app.is_platform_admin() );

revoke insert, update, delete on app.transfer_claims from authenticated, anon;

-- ================================================== submitting a receipt ===
create or replace function app.submit_transfer_claim(
  p_company   uuid,
  p_paid_on   date,
  p_bank_from text default null,
  p_narration text default null,
  p_note      text default null,
  p_receipt_path text default null,
  p_receipt_name text default null,
  p_receipt_mime text default null,
  p_receipt_bytes bigint default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_sum jsonb;
  v_ref text;
  v_amount bigint;
  v_pay uuid;
  v_label text;
  v_open int;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'Only an owner or admin can record a payment.' using errcode = '42501';
  end if;
  if p_paid_on > current_date then
    raise exception 'A transfer cannot have been made in the future.'
      using errcode = 'check_violation';
  end if;
  if p_paid_on < current_date - 90 then
    raise exception 'That transfer is more than 90 days old. Contact us instead.'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_open from app.transfer_claims
   where company_id = p_company and status = 'submitted';
  if v_open >= 3 then
    raise exception 'You already have % receipts waiting to be checked. We will get to them.', v_open
      using errcode = 'check_violation';
  end if;

  -- The amount is what the register says is owed, not what the customer types.
  -- If they paid a different figure, the review is where that surfaces —
  -- against the statement, by a person.
  v_sum := app.billing_summary(p_company);
  v_amount := (v_sum ->> 'monthly_minor')::bigint;
  if v_amount <= 0 then
    raise exception 'There is nothing owed — you are within the free allowance.'
      using errcode = 'check_violation';
  end if;

  v_ref := 'NM-' || to_char(now(), 'YYYYMMDD') || '-' ||
           substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);

  insert into app.payments
    (company_id, reference, amount_minor, assets_billed, period_start, period_end, status)
  values
    (p_company, v_ref, v_amount, (v_sum ->> 'assets')::int,
     current_date, current_date + interval '1 month', 'pending')
  returning id into v_pay;

  select coalesce(full_name, email::text, 'Unknown') into v_label
    from app.profiles where id = auth.uid();

  insert into app.transfer_claims
    (company_id, payment_id, reference, amount_minor, paid_on, bank_from,
     narration, note, receipt_path, receipt_name, receipt_mime, receipt_bytes,
     submitted_by, submitted_label)
  values
    (p_company, v_pay, v_ref, v_amount, p_paid_on, p_bank_from,
     p_narration, p_note, p_receipt_path, p_receipt_name, p_receipt_mime, p_receipt_bytes,
     auth.uid(), coalesce(v_label, 'Unknown'));

  perform app.log(p_company, 'submitted a payment receipt', 'payments', v_pay::text, v_ref,
    format('NGN %s said to be transferred on %s — awaiting confirmation',
           v_amount / 100, p_paid_on), 'info');

  return jsonb_build_object('reference', v_ref, 'amount_minor', v_amount, 'status', 'submitted');
end $$;

grant execute on function app.submit_transfer_claim(uuid, date, text, text, text, text, text, text, bigint)
  to authenticated;

-- ==================================================== confirming it ========
-- Platform staff only. A company owner confirming their own payment is not a
-- control, and this is the reason platform_admins exists at all.
create or replace function app.review_transfer_claim(
  p_claim uuid,
  p_confirm boolean,
  p_note text default null,
  p_actual_minor bigint default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_c app.transfer_claims%rowtype;
  v_label text;
  v_amount bigint;
begin
  if not app.is_platform_admin() then
    raise exception 'Only Nothing Missing staff can confirm a payment.'
      using errcode = '42501',
            hint = 'This is deliberate — a customer confirming their own transfer is not a check.';
  end if;

  select * into v_c from app.transfer_claims where id = p_claim for update;
  if not found then
    raise exception 'No such receipt.' using errcode = 'no_data_found';
  end if;
  if v_c.status <> 'submitted' then
    raise exception 'That receipt has already been reviewed.' using errcode = 'check_violation';
  end if;

  select coalesce(full_name, email::text, 'Staff') into v_label
    from app.profiles where id = auth.uid();

  if not p_confirm then
    update app.transfer_claims
       set status = 'rejected', reviewed_by = auth.uid(),
           reviewed_label = coalesce(v_label,'Staff'), reviewed_at = now(),
           review_note = p_note
     where id = p_claim;

    update app.payments set status = 'failed' where id = v_c.payment_id;

    perform app.log(v_c.company_id, 'a payment receipt was not confirmed', 'payments',
      v_c.payment_id::text, v_c.reference,
      coalesce(p_note, 'We could not find this transfer on our statement'), 'warn');

    return jsonb_build_object('status', 'rejected');
  end if;

  -- What the statement actually showed. Usually the same as claimed; when it
  -- is not, the smaller figure is what was received and that is what counts.
  v_amount := coalesce(p_actual_minor, v_c.amount_minor);

  update app.transfer_claims
     set status = 'confirmed', reviewed_by = auth.uid(),
         reviewed_label = coalesce(v_label,'Staff'), reviewed_at = now(),
         review_note = p_note, confirmed_amount_minor = v_amount
   where id = p_claim;

  update app.payments
     set status = 'succeeded', channel = 'bank transfer', paid_at = now(),
         amount_minor = v_amount
   where id = v_c.payment_id;

  update app.subscriptions
     set status = 'active', tier = 'standard',
         current_period_end = current_date + interval '1 month', updated_at = now()
   where company_id = v_c.company_id;

  insert into app.billing_events (company_id, kind, amount_minor, reference)
  values (v_c.company_id, 'bank transfer confirmed', v_amount, v_c.reference);

  perform app.log(v_c.company_id, 'confirmed a payment', 'payments',
    v_c.payment_id::text, v_c.reference,
    format('NGN %s received by bank transfer, checked against our statement by %s',
           v_amount / 100, coalesce(v_label,'staff')), 'ok');

  return jsonb_build_object('status', 'confirmed', 'amount_minor', v_amount);
end $$;

grant execute on function app.review_transfer_claim(uuid, boolean, text, bigint) to authenticated;

-- What staff see: every waiting receipt, oldest first, with enough context to
-- match it against a statement line without opening five other screens.
create or replace function app.pending_claims()
returns table (
  id uuid, company text, slug text, reference text, amount_minor bigint,
  paid_on date, bank_from text, narration text, note text,
  receipt_path text, receipt_name text, receipt_mime text,
  submitted_label text, submitted_at timestamptz, waiting_days int
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select c.id, co.name, co.slug, c.reference, c.amount_minor,
         c.paid_on, c.bank_from, c.narration, c.note,
         c.receipt_path, c.receipt_name, c.receipt_mime,
         c.submitted_label, c.submitted_at,
         extract(day from now() - c.submitted_at)::int
  from app.transfer_claims c
  join app.companies co on co.id = c.company_id
  where c.status = 'submitted' and app.is_platform_admin()
  order by c.submitted_at
$$;

grant execute on function app.pending_claims() to authenticated;

-- Receipts are namespaced by company in storage, so a bucket policy can
-- enforce the same separation the database does.
create or replace function app.receipt_path(p_company uuid, p_file text)
returns text
language sql stable as $$
  select format('receipts/%s/%s-%s',
    p_company::text,
    to_char(now(), 'YYYYMMDDHH24MISS'),
    regexp_replace(coalesce(p_file, 'receipt'), '[^a-zA-Z0-9._-]+', '-', 'g'))
$$;
