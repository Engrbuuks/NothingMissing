-- ============================================================================
-- 0018_payments_delivery.sql
-- Payments, webhook idempotency, and outbound message delivery.
--
-- The decision that shapes the payment side: Paystack retries a failed
-- delivery every three minutes and then hourly for 72 hours, so the same event
-- will arrive more than once. A webhook handler that is not idempotent will
-- credit a company twice, extend a subscription twice, and be very hard to
-- unpick afterwards. So every event is recorded by its Paystack id before
-- anything is acted on, and a second delivery of the same id does nothing.
--
-- The webhook is also the authoritative signal, not the browser redirect. A
-- customer whose network drops after paying still gets what they paid for,
-- because the truth arrives server to server rather than through a page load
-- that may never happen.
-- ============================================================================

-- --------------------------------------------------- webhook idempotency ---
create table if not exists app.webhook_events (
  id           bigserial primary key,
  provider     text not null check (provider in ('paystack','resend','termii')),
  -- the provider's own id for this event. The unique index on it is the whole
  -- mechanism: a duplicate delivery fails the insert and is ignored.
  external_id  text not null,
  event        text not null,
  company_id   uuid references app.companies(id) on delete set null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  error        text,
  unique (provider, external_id)
);

create index if not exists webhook_unprocessed_idx
  on app.webhook_events (provider, received_at) where processed_at is null;

alter table app.webhook_events enable row level security;
alter table app.webhook_events force row level security;

-- Nobody reads this through the API. It is operational, and it contains raw
-- payloads from a payment provider.
--
-- The revoke below is the real barrier, but the structural guard in CI checks
-- that every table carrying company_id has a policy — and it is right to. A
-- table with RLS enabled and no policy denies everything, which is the same
-- outcome as this one, but silently and by accident rather than on purpose.
-- An explicit deny-all policy states the intent, so a future migration adding
-- one has to remove this first and think about why.
drop policy if exists webhook_events_no_access on app.webhook_events;
create policy webhook_events_no_access on app.webhook_events
  for select using (false);

revoke select, insert, update, delete on app.webhook_events from authenticated, anon;

-- ------------------------------------------------------------- payments ----
create table if not exists app.payments (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  reference     text not null,
  amount_minor  bigint not null check (amount_minor > 0),
  currency      text not null default 'NGN',
  status        text not null default 'pending'
                  check (status in ('pending','succeeded','failed','refunded')),
  channel       text,
  paid_at       timestamptz,
  paystack_id   text,
  period_start  date,
  period_end    date,
  assets_billed int,
  created_at    timestamptz not null default now(),
  unique (company_id, reference)
);

create index if not exists payments_company_idx on app.payments (company_id, created_at desc);

alter table app.payments enable row level security;
alter table app.payments force row level security;

drop policy if exists payments_select on app.payments;
create policy payments_select on app.payments
  for select using ( app.has_role(company_id, 'owner','admin') );

revoke insert, update, delete on app.payments from authenticated, anon;

-- Starting a payment is a read of what is owed plus a reference to quote back.
-- The amount is computed here rather than accepted from the browser, because a
-- client-supplied amount is a client-supplied discount.
create or replace function app.begin_payment(p_company uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_sum jsonb;
  v_ref text;
  v_amount bigint;
  v_email text;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'Only an owner or admin can start a payment.' using errcode = '42501';
  end if;

  v_sum := app.billing_summary(p_company);
  v_amount := (v_sum ->> 'monthly_minor')::bigint;

  if v_amount <= 0 then
    raise exception 'There is nothing to pay — you are within the free allowance.'
      using errcode = 'check_violation';
  end if;

  select coalesce(email::text, '') into v_email from app.profiles where id = auth.uid();
  v_ref := 'NM-' || to_char(now(), 'YYYYMMDD') || '-' ||
           substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);

  insert into app.payments
    (company_id, reference, amount_minor, assets_billed,
     period_start, period_end, status)
  values
    (p_company, v_ref, v_amount, (v_sum ->> 'assets')::int,
     current_date, current_date + interval '1 month', 'pending');

  return jsonb_build_object(
    'reference', v_ref,
    'amount_minor', v_amount,
    'email', v_email,
    'assets', (v_sum ->> 'assets')::int);
end $$;

grant execute on function app.begin_payment(uuid) to authenticated;

-- Applied by the webhook handler, never by a browser. SECURITY DEFINER with no
-- auth.uid() check because at this point there is no session — the caller is
-- Paystack, and the proof is the signature the route already verified.
create or replace function app.apply_payment(
  p_reference text,
  p_paystack_id text,
  p_amount_minor bigint,
  p_channel text,
  p_paid_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_p app.payments%rowtype;
begin
  select * into v_p from app.payments where reference = p_reference for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown reference');
  end if;
  if v_p.status = 'succeeded' then
    -- A retry of an event already applied. Say so and change nothing.
    return jsonb_build_object('ok', true, 'reason', 'already applied');
  end if;

  -- What was charged must match what was owed. A mismatch is not something to
  -- reconcile quietly — it is either a bug or an attempt.
  if p_amount_minor <> v_p.amount_minor then
    update app.payments set status = 'failed' where id = v_p.id;
    perform app.log(v_p.company_id, 'payment amount did not match', 'payments',
      v_p.id::text, p_reference,
      format('expected %s, received %s', v_p.amount_minor, p_amount_minor), 'bad');
    return jsonb_build_object('ok', false, 'reason', 'amount mismatch');
  end if;

  update app.payments
     set status = 'succeeded', paystack_id = p_paystack_id,
         channel = p_channel, paid_at = coalesce(p_paid_at, now())
   where id = v_p.id;

  update app.subscriptions
     set status = 'active', tier = 'standard',
         current_period_end = v_p.period_end, updated_at = now()
   where company_id = v_p.company_id;

  insert into app.billing_events (company_id, kind, amount_minor, reference)
  values (v_p.company_id, 'payment received', p_amount_minor, p_reference);

  perform app.log(v_p.company_id, 'received a payment', 'payments', v_p.id::text,
    p_reference, format('NGN %s by %s', p_amount_minor / 100, coalesce(p_channel,'card')), 'ok');

  return jsonb_build_object('ok', true, 'company_id', v_p.company_id);
end $$;

create or replace function app.mark_subscription(
  p_customer_code text, p_status app.sub_status, p_period_end date default null
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_co uuid;
begin
  select company_id into v_co from app.subscriptions where customer_code = p_customer_code;
  if v_co is null then return; end if;
  update app.subscriptions
     set status = p_status,
         current_period_end = coalesce(p_period_end, current_period_end),
         updated_at = now()
   where company_id = v_co;
  perform app.log(v_co, 'subscription ' || p_status, 'subscriptions', v_co::text, null,
    null, case p_status when 'active' then 'ok' when 'past_due' then 'warn' else 'bad' end);
end $$;

-- --------------------------------------------- outbound message delivery ---
-- The notifications table records intent. This records what a provider did
-- with it, which is a different question and the one that matters when
-- somebody says they never received anything.
alter table app.notifications
  add column if not exists provider text,
  add column if not exists provider_id text,
  add column if not exists delivered_at timestamptz;

create index if not exists notifications_provider_idx
  on app.notifications (provider, provider_id) where provider_id is not null;
