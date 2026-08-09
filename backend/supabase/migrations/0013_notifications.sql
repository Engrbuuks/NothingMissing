-- ============================================================================
-- 0013_notifications.sql
--
-- Notifications as a queue, not as fire-and-forget calls.
--
-- Everything the system would send is written here first. That shape is right
-- whichever provider you end up using: a queued row survives a failed API
-- call, can be retried, and leaves a record of what was sent to whom — which
-- matters the first time somebody says they were never told about a transfer.
--
-- Nothing sends yet. Rows accumulate as 'queued' and are visible in the app,
-- so you can see exactly what would have gone out before wiring a provider up
-- and discovering it in your customers' inboxes.
-- ============================================================================

do $$ begin
  create type app.notify_channel as enum ('email','sms','whatsapp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.notify_status as enum ('queued','sent','failed','suppressed');
exception when duplicate_object then null; end $$;

create table if not exists app.notifications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  event       text not null,
  channel     app.notify_channel not null,
  recipient   text not null,
  subject     text,
  body        text,
  status      app.notify_status not null default 'queued',
  error       text,
  queued_at   timestamptz not null default now(),
  sent_at     timestamptz,
  attempts    int not null default 0
);

create index if not exists notifications_pending_idx
  on app.notifications (company_id, queued_at desc) where status = 'queued';

-- Which events go out on which channel, per company. Field staff on location
-- links have a phone number and often no work email, so the channel is a
-- per-event decision rather than one setting for everything.
create table if not exists app.notification_prefs (
  company_id uuid not null references app.companies(id) on delete cascade,
  event      text not null,
  email      boolean not null default true,
  sms        boolean not null default false,
  whatsapp   boolean not null default false,
  -- Some alerts are the safety net on the register and cannot be silenced.
  locked     boolean not null default false,
  primary key (company_id, event)
);

alter table app.notifications      enable row level security;
alter table app.notification_prefs enable row level security;
alter table app.notifications      force row level security;
alter table app.notification_prefs force row level security;

drop policy if exists notifications_select on app.notifications;
create policy notifications_select on app.notifications
  for select using ( app.has_role(company_id, 'owner','admin') );

drop policy if exists notifications_insert on app.notifications;
create policy notifications_insert on app.notifications
  for insert with check ( app.is_member(company_id) );

drop policy if exists prefs_select on app.notification_prefs;
create policy prefs_select on app.notification_prefs
  for select using ( app.is_member(company_id) );

drop policy if exists prefs_insert on app.notification_prefs;
create policy prefs_insert on app.notification_prefs
  for insert with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists prefs_update on app.notification_prefs;
create policy prefs_update on app.notification_prefs
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

-- Seed the events every company starts with. The discrepancy alert is locked:
-- it is the safety net on the register, and a company that silences it will
-- discover its own losses months late.
create or replace function app.seed_notification_prefs(p_company uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  insert into app.notification_prefs (company_id, event, email, whatsapp, locked) values
    (p_company,'transfer.raised',       true,  false, false),
    (p_company,'transfer.approved',     true,  false, false),
    (p_company,'transfer.dispatched',   true,  true,  false),
    (p_company,'transfer.overdue',      true,  true,  false),
    (p_company,'transfer.received',     true,  false, false),
    (p_company,'discrepancy.opened',    true,  true,  true),
    (p_company,'request.raised',        true,  false, false),
    (p_company,'request.decided',       true,  false, false),
    (p_company,'submission.received',   true,  true,  false),
    (p_company,'submission.reviewed',   false, true,  false),
    (p_company,'stock.below_reorder',   true,  false, false),
    (p_company,'maintenance.due',       true,  false, false),
    (p_company,'goods.received',        true,  false, false)
  on conflict (company_id, event) do nothing;
end $$;

-- A backfill only covers companies that exist when the migration runs. Anything
-- created afterwards would have no preferences at all and silently notify
-- nobody. Same trap as the slug backfill in 0010 — close it with a trigger.
create or replace function app.companies_seed_prefs()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  perform app.seed_notification_prefs(new.id);
  return new;
end $$;

drop trigger if exists companies_prefs_guard on app.companies;
create trigger companies_prefs_guard
  after insert on app.companies
  for each row execute function app.companies_seed_prefs();

do $$
declare c record;
begin
  for c in select id from app.companies loop
    perform app.seed_notification_prefs(c.id);
  end loop;
end $$;
