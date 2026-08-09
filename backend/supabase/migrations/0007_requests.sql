-- ============================================================================
-- 0007_requests.sql
-- Requests and approval chains.
--
-- The decision that shapes this file: approval rules are DATA, not code.
-- Company A wants one approver under ₦500k and two above it. Company B wants
-- the destination manager to sign as well. Hardcoding a two-step flow means a
-- rewrite by the fifth customer, so a policy is a row with ordered steps and
-- a condition, and the chain for a given request is built by matching.
--
-- The second decision: a timed-out request escalates to another human. It is
-- never auto-approved. Auto-approval keeps things moving and is what a lot of
-- systems do; it is also the fastest way to make an approval chain
-- meaningless, because once people learn that ignoring a request approves it,
-- ignoring becomes the strategy. The cost is that a truly abandoned request
-- can stall. The benefit is that every movement has a name behind it.
-- ============================================================================

do $$ begin
  create type app.request_type as enum ('transfer','repair','purchase','disposal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.request_status as enum
    ('draft','pending','approved','rejected','cancelled','fulfilled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.step_status as enum
    ('waiting','approved','rejected','skipped','delegated');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------- policies ----
create table if not exists app.approval_policies (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  request_type app.request_type not null,
  name         text not null,
  -- Evaluated in order; first match wins. A request matching nothing falls
  -- through to a single location-manager approval, so a misconfigured policy
  -- can never leave a movement unapproved.
  priority     int  not null default 100,
  min_amount_minor bigint,      -- inclusive lower bound, null = no bound
  max_amount_minor bigint,      -- exclusive upper bound, null = no bound
  min_items    int,
  max_items    int,
  -- ordered role names: ['manager','admin'] means manager first, then admin
  chain        app.role_type[] not null check (cardinality(chain) between 1 and 6),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (company_id, request_type, name)
);

create index if not exists policies_lookup_idx
  on app.approval_policies (company_id, request_type, priority) where active;

-- ------------------------------------------------------------- requests ----
create table if not exists app.requests (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  reference    text not null,
  kind         app.request_type not null,
  status       app.request_status not null default 'draft',
  title        text not null,
  detail       text,
  location_id  uuid references app.locations(id) on delete restrict,
  -- what the request is about; exactly which of these applies depends on kind
  transfer_id  uuid references app.transfers(id) on delete set null,
  asset_id     uuid references app.assets(id) on delete set null,
  amount_minor bigint check (amount_minor >= 0),
  item_count   int check (item_count >= 0),
  policy_id    uuid references app.approval_policies(id) on delete set null,
  current_step int not null default 1,
  raised_by    uuid references app.profiles(id),
  raised_at    timestamptz not null default now(),
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, reference)
);

create index if not exists requests_company_status_idx
  on app.requests (company_id, status, raised_at desc);

create table if not exists app.request_steps (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  request_id   uuid not null references app.requests(id) on delete cascade,
  step_no      int  not null check (step_no >= 1),
  required_role app.role_type not null,
  status       app.step_status not null default 'waiting',
  decided_by   uuid references app.profiles(id),
  decided_at   timestamptz,
  -- set when someone decided on another person's behalf
  on_behalf_of uuid references app.profiles(id),
  note         text,
  waiting_since timestamptz not null default now(),
  unique (request_id, step_no)
);

create index if not exists request_steps_waiting_idx
  on app.request_steps (company_id, status, waiting_since) where status = 'waiting';

-- ----------------------------------------------------------- delegation ----
create table if not exists app.delegations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  from_user   uuid not null references app.profiles(id) on delete cascade,
  to_user     uuid not null references app.profiles(id) on delete cascade,
  starts_on   date not null,
  ends_on     date not null,
  reason      text,
  created_at  timestamptz not null default now(),
  constraint delegation_window_ck check (ends_on >= starts_on),
  constraint delegation_distinct_ck check (from_user <> to_user)
);

create index if not exists delegations_active_idx
  on app.delegations (company_id, to_user, starts_on, ends_on);

-- Seniority satisfies a more junior step. An owner can sign where an admin is
-- called for, and an admin where a manager is. Without this, a policy naming
-- 'admin' is unapprovable in a company whose only senior person is the owner,
-- and every small customer is stuck on day one.
--
-- It does not work downward: a manager never satisfies an admin step. And it
-- is separate from self-approval, which no seniority overrides.
create or replace function app.role_satisfies(p_company uuid, p_needed app.role_type)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  -- the enum is declared most-privileged first, so <= means "at least as senior"
  select exists (
    select 1 from app.memberships m
    where m.company_id = p_company and m.user_id = auth.uid()
      and m.role <= p_needed
      and m.role in ('owner','admin','manager')   -- requester and auditor never approve
  )
$$;

-- True when the actor may decide a step needing p_role today.
create or replace function app.holds_or_covers(p_company uuid, p_role app.role_type)
returns boolean
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select app.role_satisfies(p_company, p_role)
      or exists (
        select 1
        from app.delegations d
        join app.memberships m
          on m.user_id = d.from_user and m.company_id = d.company_id
        where d.company_id = p_company
          and d.to_user = auth.uid()
          and current_date between d.starts_on and d.ends_on
          and m.role <= p_role
          and m.role in ('owner','admin','manager')
      )
$$;

-- =========================================================== raising one ====
-- Matching is deliberately explicit rather than clever: read the policies in
-- priority order and take the first whose bounds contain this request.
create or replace function app.match_policy(
  p_company uuid, p_kind app.request_type,
  p_amount bigint default null, p_items int default null
) returns uuid
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select p.id from app.approval_policies p
  where p.company_id = p_company and p.request_type = p_kind and p.active
    and (p.min_amount_minor is null or coalesce(p_amount, 0) >= p.min_amount_minor)
    and (p.max_amount_minor is null or coalesce(p_amount, 0) <  p.max_amount_minor)
    and (p.min_items is null or coalesce(p_items, 0) >= p.min_items)
    and (p.max_items is null or coalesce(p_items, 0) <  p.max_items)
  order by p.priority, p.created_at
  limit 1
$$;

create or replace function app.raise_request(
  p_company   uuid,
  p_kind      app.request_type,
  p_title     text,
  p_detail    text default null,
  p_location  uuid default null,
  p_transfer  uuid default null,
  p_asset     uuid default null,
  p_amount    bigint default null,
  p_items     int default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_id     uuid;
  v_ref    text;
  v_policy app.approval_policies%rowtype;
  v_chain  app.role_type[];
  v_i      int;
begin
  if not app.can_write(p_company) then
    raise exception 'not permitted to raise requests' using errcode = '42501';
  end if;
  if p_location is not null
     and not app.can_access_location(p_company, p_location) then
    raise exception 'not your location' using errcode = '42501';
  end if;

  select * into v_policy from app.approval_policies
   where id = app.match_policy(p_company, p_kind, p_amount, p_items);

  -- Fall through to a single manager approval rather than leaving a request
  -- with no chain at all. A gap in configuration must not become a gap in
  -- oversight.
  v_chain := coalesce(v_policy.chain, array['manager']::app.role_type[]);

  v_ref := app.next_doc_number(p_company, 'request');

  insert into app.requests
    (company_id, reference, kind, status, title, detail, location_id,
     transfer_id, asset_id, amount_minor, item_count, policy_id,
     current_step, raised_by)
  values
    (p_company, v_ref, p_kind, 'pending', p_title, p_detail, p_location,
     p_transfer, p_asset, p_amount, p_items, v_policy.id, 1, auth.uid())
  returning id into v_id;

  for v_i in 1 .. cardinality(v_chain) loop
    insert into app.request_steps
      (company_id, request_id, step_no, required_role, status)
    values (p_company, v_id, v_i, v_chain[v_i], 'waiting');
  end loop;

  perform app.log(p_company, 'raised request', 'requests', v_id::text, v_ref,
    format('%s: %s — %s approval step(s) required', p_kind, p_title,
           cardinality(v_chain)),
    'info', p_location);

  return v_id;
end $$;

-- ========================================================== deciding one ====
create or replace function app.decide_request(
  p_request uuid,
  p_approve boolean,
  p_note    text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r      app.requests%rowtype;
  v_step   app.request_steps%rowtype;
  v_total  int;
  v_behalf uuid;
begin
  select * into v_r from app.requests where id = p_request for update;
  if not found then
    raise exception 'request not found' using errcode = 'no_data_found';
  end if;
  if v_r.status <> 'pending' then
    raise exception 'request % is already %', v_r.reference, v_r.status
      using errcode = 'check_violation';
  end if;

  select * into v_step from app.request_steps
   where request_id = p_request and step_no = v_r.current_step;

  -- Order matters here. Self-approval is checked FIRST, because an admin who
  -- raises their own request would otherwise pass the role check and approve
  -- it. Separation of duties is not conditional on which role you hold.
  if v_r.raised_by = auth.uid() then
    raise exception 'you cannot approve a request you raised yourself'
      using errcode = '42501',
            hint = 'Ask another approver, or an owner can override.';
  end if;

  -- Then: the person deciding must hold the role this step calls for, or be
  -- covering for somebody who does.
  if not app.holds_or_covers(v_r.company_id, v_step.required_role) then
    raise exception 'this step needs a %, which you neither hold nor cover for',
      v_step.required_role using errcode = '42501';
  end if;

  if not app.role_satisfies(v_r.company_id, v_step.required_role) then
    select d.from_user into v_behalf from app.delegations d
     where d.company_id = v_r.company_id and d.to_user = auth.uid()
       and current_date between d.starts_on and d.ends_on
     limit 1;
  end if;

  update app.request_steps
     set status = (case when p_approve then 'approved' else 'rejected' end)::app.step_status,
         decided_by = auth.uid(), decided_at = now(),
         on_behalf_of = v_behalf, note = p_note
   where id = v_step.id;

  if not p_approve then
    update app.requests set status = 'rejected', decided_at = now()
     where id = p_request;
    perform app.log(v_r.company_id, 'rejected request', 'requests',
      p_request::text, v_r.reference,
      coalesce(p_note, 'no reason given'), 'warn', v_r.location_id);
    return jsonb_build_object('status','rejected','step',v_r.current_step);
  end if;

  select count(*) into v_total from app.request_steps where request_id = p_request;

  if v_r.current_step >= v_total then
    update app.requests set status = 'approved', decided_at = now()
     where id = p_request;
    -- An approved transfer request is what moves the transfer itself forward.
    if v_r.kind = 'transfer' and v_r.transfer_id is not null then
      update app.transfers set status = 'approved' where id = v_r.transfer_id;
    end if;
    perform app.log(v_r.company_id, 'approved request', 'requests',
      p_request::text, v_r.reference,
      format('final approval at step %s of %s', v_r.current_step, v_total),
      'ok', v_r.location_id);
    return jsonb_build_object('status','approved','step',v_r.current_step,'of',v_total);
  end if;

  update app.requests set current_step = current_step + 1 where id = p_request;
  update app.request_steps set waiting_since = now()
   where request_id = p_request and step_no = v_r.current_step + 1;

  perform app.log(v_r.company_id, 'approved a step', 'requests',
    p_request::text, v_r.reference,
    format('step %s of %s approved%s', v_r.current_step, v_total,
      case when v_behalf is not null then ' (covering for another approver)' else '' end),
    'info', v_r.location_id);

  return jsonb_build_object('status','pending','step',v_r.current_step + 1,'of',v_total);
end $$;

-- ----------------------------------------------------------- escalation ----
-- Run on a schedule. Escalates steps that have waited too long to the next
-- step in the chain and records the skip, so an auditor can find every
-- movement that did not follow the normal path.
create or replace function app.escalate_stale_requests(
  p_company uuid, p_after interval default interval '72 hours'
) returns int
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_r record; v_n int := 0; v_total int;
begin
  for v_r in
    select rq.id, rq.reference, rq.current_step, rq.company_id, rq.location_id,
           s.id as step_id, s.required_role, s.waiting_since
    from app.requests rq
    join app.request_steps s
      on s.request_id = rq.id and s.step_no = rq.current_step
    where rq.company_id = p_company
      and rq.status = 'pending'
      and s.status = 'waiting'
      and s.waiting_since < now() - p_after
  loop
    select count(*) into v_total from app.request_steps where request_id = v_r.id;
    if v_r.current_step >= v_total then
      continue;   -- nothing left to escalate to; it stalls, visibly
    end if;

    update app.request_steps set status = 'skipped',
           note = format('Escalated automatically after %s without a decision', p_after)
     where id = v_r.step_id;

    update app.requests set current_step = current_step + 1 where id = v_r.id;
    update app.request_steps set waiting_since = now()
     where request_id = v_r.id and step_no = v_r.current_step + 1;

    perform app.log(v_r.company_id, 'escalated a request', 'requests',
      v_r.id::text, v_r.reference,
      format('step %s (%s) passed without a decision and was escalated',
             v_r.current_step, v_r.required_role),
      'warn', v_r.location_id);

    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------- RLS ------
alter table app.approval_policies enable row level security;
alter table app.requests          enable row level security;
alter table app.request_steps     enable row level security;
alter table app.delegations       enable row level security;

alter table app.approval_policies force row level security;
alter table app.requests          force row level security;
alter table app.request_steps     force row level security;
alter table app.delegations       force row level security;

drop policy if exists policies_select on app.approval_policies;
create policy policies_select on app.approval_policies
  for select using ( app.is_member(company_id) );

drop policy if exists policies_insert on app.approval_policies;
create policy policies_insert on app.approval_policies
  for insert with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists policies_update on app.approval_policies;
create policy policies_update on app.approval_policies
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists policies_delete on app.approval_policies;
create policy policies_delete on app.approval_policies
  for delete using ( app.has_role(company_id, 'owner','admin') );

drop policy if exists requests_select on app.requests;
create policy requests_select on app.requests
  for select using (
    app.is_member(company_id)
    and (location_id is null or app.can_access_location(company_id, location_id))
  );

drop policy if exists requests_insert on app.requests;
create policy requests_insert on app.requests
  for insert with check ( app.can_write(company_id) );

drop policy if exists requests_update on app.requests;
create policy requests_update on app.requests
  for update
  using      ( app.can_write(company_id) )
  with check ( app.can_write(company_id) );

drop policy if exists request_steps_select on app.request_steps;
create policy request_steps_select on app.request_steps
  for select using ( app.is_member(company_id) );

drop policy if exists delegations_select on app.delegations;
create policy delegations_select on app.delegations
  for select using ( app.is_member(company_id) );

drop policy if exists delegations_insert on app.delegations;
create policy delegations_insert on app.delegations
  for insert with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists delegations_update on app.delegations;
create policy delegations_update on app.delegations
  for update
  using      ( app.has_role(company_id, 'owner','admin') )
  with check ( app.has_role(company_id, 'owner','admin') );

drop policy if exists delegations_delete on app.delegations;
create policy delegations_delete on app.delegations
  for delete using ( app.has_role(company_id, 'owner','admin') );

-- Steps are written only through decide_request(), so a client cannot mark a
-- step approved without passing the role check.
revoke insert, update, delete on app.request_steps from authenticated, anon;

drop trigger if exists audit_requests on app.requests;
create trigger audit_requests after insert or update on app.requests
  for each row execute function app.audit_row_change('reference', 'location_id');

drop trigger if exists touch_requests on app.requests;
create trigger touch_requests before update on app.requests
  for each row execute function app.touch_updated_at();

-- 'request' joins the document counter kinds
alter table app.doc_counters drop constraint if exists doc_counters_kind_check;
alter table app.doc_counters add constraint doc_counters_kind_check
  check (kind in ('waybill','po','disposal','import','claim','request','count'));

create or replace function app.next_doc_number(p_company uuid, p_kind text)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_year int := extract(year from now())::int;
  v_next int;
  v_pfx  text := case p_kind
                   when 'waybill'  then 'WB'
                   when 'po'       then 'PO'
                   when 'disposal' then 'DSP'
                   when 'import'   then 'IMP'
                   when 'claim'    then 'CLM'
                   when 'request'  then 'REQ'
                   when 'count'    then 'SC'
                 end;
begin
  insert into app.doc_counters (company_id, kind, year, last_value)
  values (p_company, p_kind, v_year, 0)
  on conflict (company_id, kind, year) do nothing;

  update app.doc_counters
     set last_value = last_value + 1
   where company_id = p_company and kind = p_kind and year = v_year
  returning last_value into v_next;

  return format('%s-%s-%s', v_pfx, v_year, lpad(v_next::text, 4, '0'));
end $$;
