-- ============================================================================
-- 0038_email_approvals.sql
-- Approvers who have no account.
--
-- The approval chain has always been role-based: a step names `manager` and
-- somebody holding that role signs it. That covers everyone on the payroll and
-- nobody outside it — and the people who actually hold up a purchase order in
-- practice are often exactly the people without a seat: a director who checks
-- spend once a week, an owner's accountant, a landlord signing off a fit-out.
-- Buying them a seat to click one button a month is not going to happen, so
-- the approval waits, or somebody clicks it on their behalf, which is worse
-- because the log then says the wrong name.
--
-- An external approver is a name and an email. They get a message with a link
-- and they decide. No password, no account, nothing to remember.
--
-- ============================================================================
-- THE LINK IS NOT THE DECISION
-- ============================================================================
-- The single most important property here, and the one that is easy to get
-- wrong: opening the link must not approve anything.
--
-- Mail servers, spam filters, link scanners and preview generators all fetch
-- URLs found in messages, without a human involved. Microsoft Defender and
-- Gmail both do it. If GET /a/<token> approved the request, a scanner would
-- approve a two-million-naira purchase order somewhere between the sending
-- server and the recipient's inbox, and it would look exactly like the
-- approver did it.
--
-- So the token only ever RESOLVES on GET — it returns what is being asked and
-- renders a page. The decision is a POST the person makes on that page.
-- `resolve_approval_task()` is read-only for that reason, and it is the only
-- thing anon may call with a token besides the deciding function.
--
-- The rest of the shape follows the field links in 0008, including the lesson
-- from 0011: the token goes in the PATH, never a fragment, because a fragment
-- is not sent to the server and the page would receive nothing.
-- ============================================================================

-- ================================================================ people ====
create table if not exists app.external_approvers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 120),
  email       text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  active      boolean not null default true,
  created_by  uuid references app.profiles(id),
  created_at  timestamptz not null default now()
);

-- Case-insensitive: somebody will add Ade@x.com and later ade@x.com and then
-- wonder why two emails arrive for one approval.
create unique index if not exists external_approvers_email_uq
  on app.external_approvers (company_id, lower(email));

alter table app.external_approvers enable row level security;
alter table app.external_approvers force row level security;

drop policy if exists ext_approvers_select on app.external_approvers;
create policy ext_approvers_select on app.external_approvers
  for select using (app.is_member(company_id));

drop policy if exists ext_approvers_write on app.external_approvers;
create policy ext_approvers_write on app.external_approvers
  for all using (app.has_role(company_id, 'owner', 'admin'))
      with check (app.has_role(company_id, 'owner', 'admin'));

-- ============================================== which processes, per person ==
-- The checkbox matrix: this approver, these kinds of request.
create table if not exists app.external_approver_scopes (
  company_id   uuid not null references app.companies(id) on delete cascade,
  approver_id  uuid not null references app.external_approvers(id) on delete cascade,
  request_type app.request_type not null,
  primary key (approver_id, request_type)
);

alter table app.external_approver_scopes enable row level security;
alter table app.external_approver_scopes force row level security;

drop policy if exists ext_scopes_select on app.external_approver_scopes;
create policy ext_scopes_select on app.external_approver_scopes
  for select using (app.is_member(company_id));

drop policy if exists ext_scopes_write on app.external_approver_scopes;
create policy ext_scopes_write on app.external_approver_scopes
  for all using (app.has_role(company_id, 'owner', 'admin'))
      with check (app.has_role(company_id, 'owner', 'admin'));

-- ================================================================ quorum ====
do $$ begin
  create type app.quorum_mode as enum ('any', 'all');
exception when duplicate_object then null; end $$;

create table if not exists app.external_quorum (
  company_id   uuid not null references app.companies(id) on delete cascade,
  request_type app.request_type not null,
  mode         app.quorum_mode not null default 'any',
  primary key (company_id, request_type)
);

comment on table app.external_quorum is
  'Whether one external approver is enough for this kind of request, or all of '
  'them must agree. Defaults to any: waiting on every named person is how an '
  'approval sits for a week because somebody is on leave.';

alter table app.external_quorum enable row level security;
alter table app.external_quorum force row level security;

drop policy if exists ext_quorum_select on app.external_quorum;
create policy ext_quorum_select on app.external_quorum
  for select using (app.is_member(company_id));

drop policy if exists ext_quorum_write on app.external_quorum;
create policy ext_quorum_write on app.external_quorum
  for all using (app.has_role(company_id, 'owner', 'admin'))
      with check (app.has_role(company_id, 'owner', 'admin'));

-- ================================================================= tasks ====
do $$ begin
  create type app.task_decision as enum ('approved', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists app.approval_tasks (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  request_id  uuid not null references app.requests(id) on delete cascade,
  approver_id uuid not null references app.external_approvers(id) on delete cascade,
  -- Only the hash is stored. The token is shown once, in the email, and is
  -- unrecoverable from here — so a database read does not hand somebody the
  -- ability to approve.
  token_hash  text not null,
  expires_on  date not null,
  -- When the token was handed to the mailer. A task with no sent_at has a
  -- token nobody has received, so it is safe to rotate — which is what makes
  -- both "raise then send" and "resend" work without ever storing plaintext.
  sent_at     timestamptz,
  decision    app.task_decision,
  decided_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now(),
  unique (request_id, approver_id),
  constraint task_decided_ck check (
    (decision is null and decided_at is null)
    or (decision is not null and decided_at is not null))
);

create unique index if not exists approval_tasks_token_idx
  on app.approval_tasks (token_hash);
create index if not exists approval_tasks_request_idx
  on app.approval_tasks (request_id) where decision is null;

alter table app.approval_tasks enable row level security;
alter table app.approval_tasks force row level security;

drop policy if exists approval_tasks_select on app.approval_tasks;
create policy approval_tasks_select on app.approval_tasks
  for select using (app.is_member(company_id));

-- No write policy at all, deliberately. Tasks are created by
-- ensure_approval_tasks() and decided by decide_by_token(), both SECURITY
-- DEFINER. A signed-in user updating this table directly would be approving
-- as somebody else.

-- ====================================================== state on a request ==
do $$ begin
  create type app.external_state as enum
    ('not_required', 'pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

alter table app.requests
  add column if not exists external_state app.external_state
    not null default 'not_required';

comment on column app.requests.external_state is
  'The email-approver gate, tracked separately from the role chain because the '
  'two run in parallel: a request is approved only when the chain is complete '
  'AND this is satisfied. Requests raised before any external approver existed '
  'stay not_required, so nothing already in flight is held up by this feature.';

-- =========================================================== the processes ==
-- What can be tied to an email approver. Returned as data so the settings page
-- renders the list rather than hardcoding it — a request type added later
-- appears here without anybody remembering to update a page.
create or replace function app.approval_processes()
returns table (request_type text, label text, detail text)
language sql immutable as $$
  select * from (values
    ('purchase', 'Purchase requests',
     'Buying something. The one most companies want a director on.'),
    ('repair',   'Repair requests',
     'Fixing something that has broken, and the cost of doing so.'),
    ('transfer', 'Transfers between locations',
     'Assets moving from one register to another.'),
    ('disposal', 'Disposals and write-offs',
     'Selling, scrapping or writing off. Irreversible, and the one an auditor looks at first.')
  ) as t(request_type, label, detail)
$$;

grant execute on function app.approval_processes() to authenticated;

-- ======================================================== managing people ===
create or replace function app.save_external_approver(
  p_company  uuid,
  p_name     text,
  p_email    text,
  p_types    text[] default '{}',
  p_approver uuid default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_id uuid;
  v_t  text;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'only an owner or admin can manage approvers'
      using errcode = '42501';
  end if;

  if p_approver is null then
    insert into app.external_approvers (company_id, name, email, created_by)
    values (p_company, btrim(p_name), lower(btrim(p_email)), auth.uid())
    returning id into v_id;
  else
    update app.external_approvers
       set name = btrim(p_name), email = lower(btrim(p_email))
     where id = p_approver and company_id = p_company
     returning id into v_id;
    if v_id is null then
      raise exception 'approver not found' using errcode = 'no_data_found';
    end if;
  end if;

  -- Scopes are replaced wholesale: the form posts the full set of ticked
  -- boxes, so an unticked one must come off. Merging would make it impossible
  -- to remove somebody from a process.
  delete from app.external_approver_scopes where approver_id = v_id;
  foreach v_t in array coalesce(p_types, '{}') loop
    if v_t is not null and btrim(v_t) <> '' then
      insert into app.external_approver_scopes (company_id, approver_id, request_type)
      values (p_company, v_id, v_t::app.request_type)
      on conflict do nothing;
    end if;
  end loop;

  perform app.log(p_company, 'saved an email approver', 'external_approvers',
    v_id::text, btrim(p_name),
    format('%s — %s', lower(btrim(p_email)),
      case when coalesce(array_length(p_types,1),0) = 0
           then 'no processes selected, so they will not be asked for anything'
           else 'approves: ' || array_to_string(p_types, ', ') end),
    'info');

  return v_id;
end $$;

revoke all on function app.save_external_approver(uuid, text, text, text[], uuid) from public;
grant execute on function app.save_external_approver(uuid, text, text, text[], uuid) to authenticated;

create or replace function app.remove_external_approver(p_approver uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_a app.external_approvers%rowtype;
begin
  select * into v_a from app.external_approvers where id = p_approver;
  if not found then return; end if;
  if not app.has_role(v_a.company_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can remove an approver'
      using errcode = '42501';
  end if;

  -- Deactivated rather than deleted when they have already decided something:
  -- deleting would cascade their tasks away and a request would lose the
  -- record of who approved it.
  if exists (select 1 from app.approval_tasks
              where approver_id = p_approver and decision is not null) then
    update app.external_approvers set active = false where id = p_approver;
    delete from app.external_approver_scopes where approver_id = p_approver;
    perform app.log(v_a.company_id, 'retired an email approver',
      'external_approvers', p_approver::text, v_a.name,
      'kept, because they have approved things and that record stands', 'info');
  else
    delete from app.external_approvers where id = p_approver;
    perform app.log(v_a.company_id, 'removed an email approver',
      'external_approvers', p_approver::text, v_a.name,
      'had approved nothing, so nothing referenced them', 'info');
  end if;
end $$;

revoke all on function app.remove_external_approver(uuid) from public;
grant execute on function app.remove_external_approver(uuid) to authenticated;

create or replace function app.set_external_quorum(
  p_company uuid, p_type text, p_mode text
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'only an owner or admin can set this' using errcode = '42501';
  end if;
  insert into app.external_quorum (company_id, request_type, mode)
  values (p_company, p_type::app.request_type, p_mode::app.quorum_mode)
  on conflict (company_id, request_type) do update set mode = excluded.mode;
end $$;

revoke all on function app.set_external_quorum(uuid, text, text) from public;
grant execute on function app.set_external_quorum(uuid, text, text) to authenticated;

-- ================================================== creating the tasks ======
-- Two functions, deliberately, because they answer to different masters.
--
-- ensure_approval_tasks() is called by raise_request(), so a request can never
-- be raised without its email approvers being asked. It issues no usable token
-- and marks nothing as sent.
--
-- claim_approval_tokens() is called by whatever is actually going to send the
-- messages. It mints a token per unsent task, hands it over once and records
-- that it did. Splitting them is what makes "created but not yet emailed" a
-- state that exists — one function doing both meant raise_request() consumed
-- the tokens and discarded them, and nothing could ever send anything.
create or replace function app.ensure_approval_tasks(p_request uuid)
returns int
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r app.requests%rowtype;
  v_n int := 0;
begin
  select * into v_r from app.requests where id = p_request;
  if not found then return 0; end if;

  insert into app.approval_tasks
    (company_id, request_id, approver_id, token_hash, expires_on)
  select v_r.company_id, p_request, ea.id,
         -- A placeholder that hashes nothing anybody holds. Replaced the
         -- moment a token is claimed; until then this task cannot be opened
         -- by anyone, which is the correct state for an unsent invitation.
         encode(digest(gen_random_uuid()::text || clock_timestamp()::text, 'sha256'), 'hex'),
         current_date + 30
    from app.external_approvers ea
    join app.external_approver_scopes sc on sc.approver_id = ea.id
   where ea.company_id = v_r.company_id
     and ea.active
     and sc.request_type = v_r.kind
  on conflict (request_id, approver_id) do nothing;

  get diagnostics v_n = row_count;

  if v_n > 0 then
    update app.requests set external_state = 'pending'
     where id = p_request and external_state = 'not_required';
  end if;

  return v_n;
end $$;

revoke all on function app.ensure_approval_tasks(uuid) from public;
grant execute on function app.ensure_approval_tasks(uuid) to authenticated;

-- Mint and hand over the tokens for everything not yet sent. Returns them
-- ONCE; only the hash is kept, so there is no second chance to read them and
-- resend_approval_task() is the recovery path if the mail fails.
create or replace function app.claim_approval_tokens(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r     app.requests%rowtype;
  v_t     record;
  v_token text;
  v_out   jsonb := '[]'::jsonb;
begin
  select * into v_r from app.requests where id = p_request;
  if not found then return v_out; end if;
  if not app.is_member(v_r.company_id) then
    raise exception 'not your request' using errcode = '42501';
  end if;

  for v_t in
    select t.id, ea.name, ea.email
      from app.approval_tasks t
      join app.external_approvers ea on ea.id = t.approver_id
     where t.request_id = p_request
       and t.sent_at is null
       and t.decision is null
  loop
    v_token := encode(gen_random_bytes(24), 'hex');
    update app.approval_tasks
       set token_hash = encode(digest(v_token, 'sha256'), 'hex'),
           sent_at = now()
     where id = v_t.id;

    v_out := v_out || jsonb_build_object(
      'task', v_t.id, 'name', v_t.name, 'email', v_t.email, 'token', v_token);
  end loop;

  return v_out;
end $$;

revoke all on function app.claim_approval_tokens(uuid) from public;
grant execute on function app.claim_approval_tokens(uuid) to authenticated;

-- ============================================================== resending ===
-- A fresh token for one task. The old one stops working the moment this runs,
-- which is the point: an approval link that was emailed to the wrong address,
-- or forwarded somewhere it should not have gone, is replaced rather than
-- merely re-sent alongside the original.
create or replace function app.resend_approval_task(p_task uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t     app.approval_tasks%rowtype;
  v_a     app.external_approvers%rowtype;
  v_r     app.requests%rowtype;
  v_token text;
begin
  select * into v_t from app.approval_tasks where id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_t.company_id, 'owner', 'admin') then
    raise exception 'only an owner or admin can resend an approval'
      using errcode = '42501';
  end if;
  if v_t.decision is not null then
    raise exception 'that approver has already decided' using errcode = 'check_violation';
  end if;

  select * into v_a from app.external_approvers where id = v_t.approver_id;
  select * into v_r from app.requests where id = v_t.request_id;

  v_token := encode(gen_random_bytes(24), 'hex');
  update app.approval_tasks
     set token_hash = encode(digest(v_token, 'sha256'), 'hex'),
         expires_on = current_date + 30,
         sent_at = now()
   where id = p_task;

  perform app.log(v_t.company_id, 'reissued an approval link', 'requests',
    v_r.id::text, v_r.reference,
    format('a new link was sent to %s <%s>; the previous one stopped working',
           v_a.name, v_a.email), 'info', v_r.location_id);

  return jsonb_build_object('token', v_token, 'email', v_a.email,
                            'name', v_a.name, 'reference', v_r.reference,
                            'title', v_r.title, 'kind', v_r.kind,
                            'amount_minor', v_r.amount_minor);
end $$;

revoke all on function app.resend_approval_task(uuid) from public;
grant execute on function app.resend_approval_task(uuid) to authenticated;

-- ================================================ finishing a request =======
-- Both halves call this: the role chain and the email approvers finish in
-- either order, and whichever lands last is the one that completes the
-- request. Keeping the rule in one function means the two paths cannot
-- disagree about when something is approved.
create or replace function app.try_finalise_request(p_request uuid)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_r     app.requests%rowtype;
  v_total int;
  v_done  int;
begin
  select * into v_r from app.requests where id = p_request for update;
  if not found or v_r.status <> 'pending' then
    return coalesce(v_r.status::text, 'gone');
  end if;

  if v_r.external_state = 'rejected' then
    update app.requests set status = 'rejected', decided_at = now()
     where id = p_request;
    return 'rejected';
  end if;

  select count(*) into v_total from app.request_steps where request_id = p_request;
  select count(*) into v_done  from app.request_steps
   where request_id = p_request and status = 'approved';

  if v_done < v_total then return 'pending'; end if;
  if v_r.external_state = 'pending' then return 'awaiting_external'; end if;

  update app.requests set status = 'approved', decided_at = now()
   where id = p_request;

  if v_r.kind = 'transfer' and v_r.transfer_id is not null then
    update app.transfers set status = 'approved' where id = v_r.transfer_id;
  end if;

  perform app.log(v_r.company_id, 'approved request', 'requests',
    p_request::text, v_r.reference,
    format('all %s internal step(s) signed%s', v_total,
      case when v_r.external_state = 'approved'
           then ' and the email approvers agreed' else '' end),
    'ok', v_r.location_id);

  return 'approved';
end $$;

revoke all on function app.try_finalise_request(uuid) from public;
grant execute on function app.try_finalise_request(uuid) to authenticated;

-- ================================================ resolving a token (anon) ==
-- READ ONLY. This is what the emailed link hits, and link scanners hit it too,
-- so it must be safe to call a hundred times with no effect.
create or replace function app.resolve_approval_task(p_token text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t   app.approval_tasks%rowtype;
  v_r   app.requests%rowtype;
  v_a   app.external_approvers%rowtype;
  v_co  text;
  v_loc text;
begin
  select * into v_t from app.approval_tasks
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');

  -- One answer for "no such token" and "expired": telling an anonymous caller
  -- which it is turns this into a way to test tokens.
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;
  if v_t.expires_on < current_date then
    return jsonb_build_object('state', 'expired');
  end if;

  select * into v_r from app.requests where id = v_t.request_id;
  select * into v_a from app.external_approvers where id = v_t.approver_id;
  select name into v_co from app.companies where id = v_t.company_id;
  select name into v_loc from app.locations where id = v_r.location_id;

  if v_t.decision is not null then
    return jsonb_build_object(
      'state', 'decided', 'decision', v_t.decision,
      'decided_at', v_t.decided_at, 'reference', v_r.reference,
      'title', v_r.title, 'company', v_co, 'approver', v_a.name);
  end if;

  return jsonb_build_object(
    'state',       'open',
    'reference',   v_r.reference,
    'kind',        v_r.kind,
    'title',       v_r.title,
    'detail',      v_r.detail,
    'amount_minor',v_r.amount_minor,
    'location',    v_loc,
    'company',     v_co,
    'approver',    v_a.name,
    'raised_at',   v_r.raised_at,
    'request_status', v_r.status);
end $$;

revoke all on function app.resolve_approval_task(text) from public;
grant execute on function app.resolve_approval_task(text) to anon, authenticated;

-- =================================================== deciding (anon, POST) ==
create or replace function app.decide_by_token(
  p_token   text,
  p_approve boolean,
  p_note    text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t     app.approval_tasks%rowtype;
  v_r     app.requests%rowtype;
  v_a     app.external_approvers%rowtype;
  v_mode  app.quorum_mode;
  v_open  int;
  v_yes   int;
  v_final text;
begin
  select * into v_t from app.approval_tasks
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'state', 'invalid');
  end if;
  if v_t.expires_on < current_date then
    return jsonb_build_object('ok', false, 'state', 'expired');
  end if;
  -- Single use. A forwarded email cannot be used to change a decision.
  if v_t.decision is not null then
    return jsonb_build_object('ok', false, 'state', 'decided',
                              'decision', v_t.decision);
  end if;

  select * into v_r from app.requests where id = v_t.request_id for update;
  if v_r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'state', 'closed',
                              'request_status', v_r.status);
  end if;

  select * into v_a from app.external_approvers where id = v_t.approver_id;

  update app.approval_tasks
     set decision = (case when p_approve then 'approved' else 'rejected' end)::app.task_decision,
         decided_at = now(),
         note = nullif(btrim(p_note), '')
   where id = v_t.id;

  -- The audit row names the person, not "an external approver". The whole
  -- point of giving them their own link is that the log can say who decided.
  perform app.log(v_t.company_id,
    case when p_approve then 'approved by email' else 'rejected by email' end,
    'requests', v_r.id::text, v_r.reference,
    format('%s <%s> %s %s%s', v_a.name, v_a.email,
           case when p_approve then 'approved' else 'rejected' end,
           v_r.reference,
           case when nullif(btrim(p_note),'') is not null
                then ' — ' || btrim(p_note) else '' end),
    -- Cast required: a CASE over two string literals is `unknown`, and
    -- app.log() takes app.audit_tone, so this resolves to no function at all
    -- and fails at runtime rather than at deploy.
    (case when p_approve then 'ok' else 'warn' end)::app.audit_tone,
    v_r.location_id);

  -- A rejection ends it, whatever the quorum. "Any one is enough" is a rule
  -- about how much agreement is needed to proceed, not licence to ignore
  -- somebody who said no — and failing closed is the safe direction when the
  -- thing being decided is money leaving the company.
  if not p_approve then
    update app.requests set external_state = 'rejected' where id = v_r.id;
    v_final := app.try_finalise_request(v_r.id);
    return jsonb_build_object('ok', true, 'state', 'rejected',
                              'reference', v_r.reference, 'request', v_final);
  end if;

  select coalesce(mode, 'any') into v_mode from app.external_quorum
   where company_id = v_t.company_id and request_type = v_r.kind;
  v_mode := coalesce(v_mode, 'any');

  select count(*) filter (where decision is null),
         count(*) filter (where decision = 'approved')
    into v_open, v_yes
    from app.approval_tasks where request_id = v_r.id;

  if v_mode = 'any' or v_open = 0 then
    update app.requests set external_state = 'approved' where id = v_r.id;
  end if;

  v_final := app.try_finalise_request(v_r.id);

  return jsonb_build_object(
    'ok', true, 'state', 'approved',
    'reference', v_r.reference,
    'quorum', v_mode,
    'still_waiting_on', case when v_mode = 'any' then 0 else v_open end,
    'request', v_final);
end $$;

revoke all on function app.decide_by_token(text, boolean, text) from public;
grant execute on function app.decide_by_token(text, boolean, text) to anon, authenticated;

-- ========================================== the two existing entry points ===
-- raise_request(): unchanged except that it now creates the email tasks. The
-- tokens are returned to the caller so the mailer can send them, because they
-- are never readable again afterwards.
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

  -- Email approvers, if any are scoped to this kind of request. Nothing
  -- changes for a company that has none: external_state stays not_required.
  perform app.ensure_approval_tasks(v_id);

  return v_id;
end $$;

-- decide_request(): the role side. The only change is that completing the
-- chain no longer approves the request by itself — try_finalise_request()
-- decides, because the email approvers may not have answered yet.
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
  v_final  text;
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

  if v_r.raised_by = auth.uid() then
    raise exception 'you cannot approve a request you raised yourself'
      using errcode = '42501',
            hint = 'Ask another approver, or an owner can override.';
  end if;

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
    v_final := app.try_finalise_request(p_request);
    if v_final = 'awaiting_external' then
      perform app.log(v_r.company_id, 'approved a step', 'requests',
        p_request::text, v_r.reference,
        format('final internal step %s of %s approved — waiting on the email approvers',
               v_r.current_step, v_total),
        'info', v_r.location_id);
      return jsonb_build_object('status','awaiting_external',
                                'step',v_r.current_step,'of',v_total);
    end if;
    return jsonb_build_object('status', v_final, 'step', v_r.current_step, 'of', v_total);
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

-- ==================================================== who is still waiting ==
create or replace function app.pending_external(p_request uuid)
returns table (task_id uuid, name text, email text, decision text,
               decided_at timestamptz, note text)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select t.id, ea.name, ea.email, t.decision::text, t.decided_at, t.note
    from app.approval_tasks t
    join app.external_approvers ea on ea.id = t.approver_id
   where t.request_id = p_request
     and app.is_member(t.company_id)
   order by t.decided_at nulls first, ea.name
$$;

grant execute on function app.pending_external(uuid) to authenticated;

-- ============================================================ the slug =====
-- /a/<token> is the approval link. It has to be reserved on both sides or a
-- customer claims the address and the router can no longer resolve it — and
-- tests-reserved-parity.mjs fails the build if the two lists disagree, which
-- is how a missing entry gets noticed rather than discovered by a customer.
insert into app.reserved_slugs (slug, reason)
values ('a', 'approval links')
on conflict (slug) do nothing;
