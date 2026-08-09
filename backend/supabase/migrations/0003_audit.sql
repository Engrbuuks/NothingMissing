-- ============================================================================
-- 0003_audit.sql
-- The audit log.
--
-- This is the backbone, not a feature. Two things make it trustworthy:
--
--   1. It is append-only at the database level, not by convention. There is
--      no UPDATE or DELETE policy, the privileges are revoked outright, and
--      a trigger raises on any attempt regardless. Owners cannot edit it.
--      Neither can the application role.
--
--   2. Rows are written by triggers inside the same transaction as the change
--      they describe. If the change rolls back, so does its audit row; if the
--      audit write fails, the change fails with it. Application code cannot
--      forget to log something, because application code is not what logs it.
-- ============================================================================

do $$ begin
  create type app.audit_tone as enum ('info','ok','warn','bad');
exception when duplicate_object then null; end $$;

create table if not exists app.audit_events (
  id           bigserial primary key,
  company_id   uuid        not null references app.companies(id) on delete cascade,
  occurred_at  timestamptz not null default now(),

  actor_id     uuid        references app.profiles(id),
  actor_label  text        not null,   -- kept as text so it survives a deleted profile
  actor_kind   text        not null default 'user'
                 check (actor_kind in ('user','link','system')),

  action       text        not null,   -- 'accepted delivery', 'archived location'
  entity       text        not null,   -- table name the change happened to
  entity_id    text,                   -- pk as text: entities have different key types
  reference    text,                   -- human handle: 'WB-2026-0148', 'ZF-GEN-0041'
  detail       text,
  tone         app.audit_tone not null default 'info',

  before_state jsonb,
  after_state  jsonb,

  location_id  uuid references app.locations(id),
  request_id   text                     -- ties every row from one API call together
);

create index if not exists audit_company_time_idx
  on app.audit_events (company_id, occurred_at desc);
create index if not exists audit_entity_idx
  on app.audit_events (company_id, entity, entity_id);
create index if not exists audit_reference_idx
  on app.audit_events (company_id, reference) where reference is not null;

alter table app.audit_events enable row level security;
alter table app.audit_events force row level security;

-- Anyone in the company can read it. That is the point: an audit trail only
-- deters anything if the people it describes know it is visible.
drop policy if exists audit_select on app.audit_events;
create policy audit_select on app.audit_events
  for select using ( app.is_member(company_id) );

-- No insert policy either: rows arrive through SECURITY DEFINER functions,
-- so a client cannot forge an entry claiming someone else did something.
-- No update policy. No delete policy. Deliberately.

revoke update, delete, truncate on app.audit_events from authenticated, anon;

create or replace function app.audit_is_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'the audit log is append-only: % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Correct a mistake by writing a further event, not by editing history.';
end $$;

drop trigger if exists audit_no_update on app.audit_events;
create trigger audit_no_update before update on app.audit_events
  for each row execute function app.audit_is_immutable();

drop trigger if exists audit_no_delete on app.audit_events;
create trigger audit_no_delete before delete on app.audit_events
  for each row execute function app.audit_is_immutable();

drop trigger if exists audit_no_truncate on app.audit_events;
create trigger audit_no_truncate before truncate on app.audit_events
  execute function app.audit_is_immutable();

-- ------------------------------------------------------------- writer ------
create or replace function app.log(
  p_company   uuid,
  p_action    text,
  p_entity    text,
  p_entity_id text    default null,
  p_reference text    default null,
  p_detail    text    default null,
  p_tone      app.audit_tone default 'info',
  p_location  uuid    default null,
  p_before    jsonb   default null,
  p_after     jsonb   default null
) returns bigint
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_id    bigint;
  v_user  uuid := auth.uid();
  v_label text;
  v_kind  text := 'user';
begin
  if v_user is null then
    v_label := coalesce(current_setting('app.actor_label', true), 'System');
    v_kind  := coalesce(current_setting('app.actor_kind',  true), 'system');
  else
    select coalesce(p.full_name, p.email::text) into v_label
    from app.profiles p where p.id = v_user;
    v_label := coalesce(v_label, 'Unknown user');
  end if;

  insert into app.audit_events (
    company_id, actor_id, actor_label, actor_kind, action, entity, entity_id,
    reference, detail, tone, location_id, before_state, after_state, request_id)
  values (
    p_company, v_user, v_label, v_kind, p_action, p_entity, p_entity_id,
    p_reference, p_detail, p_tone, p_location, p_before, p_after,
    nullif(current_setting('app.request_id', true), ''))
  returning id into v_id;

  return v_id;
end $$;

comment on function app.log is
  'The only supported way to write an audit row. SECURITY DEFINER so the actor is taken from the session, never from the caller.';

-- ------------------------------------------------ generic change tracker ---
-- Attach to any tenant table to record inserts, updates and deletes without
-- the application having to remember. Configure with trigger arguments:
--   arg 0: reference column (optional)  arg 1: location column (optional)
create or replace function app.audit_row_change()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid;
  v_ref     text;
  v_loc     uuid;
  v_before  jsonb;
  v_after   jsonb;
  v_action  text;
  v_row     jsonb;
begin
  v_row := to_jsonb(coalesce(new, old));
  v_company := (v_row ->> 'company_id')::uuid;
  if v_company is null then
    return coalesce(new, old);   -- not a tenant table; nothing to attribute
  end if;

  if tg_nargs > 0 and tg_argv[0] is not null and tg_argv[0] <> '' then
    v_ref := v_row ->> tg_argv[0];
  end if;
  if tg_nargs > 1 and tg_argv[1] is not null and tg_argv[1] <> '' then
    v_loc := nullif(v_row ->> tg_argv[1], '')::uuid;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'created ' || tg_table_name;
    v_after  := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_action := 'updated ' || tg_table_name;
    v_before := to_jsonb(old);
    v_after   := to_jsonb(new);
    -- nothing actually changed: do not write a row saying it did
    if v_before = v_after then return new; end if;
  else
    v_action := 'deleted ' || tg_table_name;
    v_before := to_jsonb(old);
  end if;

  perform app.log(
    v_company, v_action, tg_table_name, (v_row ->> 'id'),
    v_ref, null,
    case tg_op when 'DELETE' then 'warn'::app.audit_tone else 'info'::app.audit_tone end,
    v_loc, v_before, v_after);

  return coalesce(new, old);
end $$;

-- Tenancy tables get it immediately; asset and movement tables pick it up
-- in the migrations that create them.
drop trigger if exists audit_locations on app.locations;
create trigger audit_locations after insert or update or delete on app.locations
  for each row execute function app.audit_row_change('name', 'id');

drop trigger if exists audit_memberships on app.memberships;
create trigger audit_memberships after insert or update or delete on app.memberships
  for each row execute function app.audit_row_change('role', 'location_id');
