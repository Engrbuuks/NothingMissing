-- ============================================================================
-- 0005_transfers.sql
-- Movement: transfers, waybills, discrepancies, location archiving.
--
-- The whole product rests on one operation being trustworthy — accepting a
-- delivery. app.accept_transfer() is a single function so that moving every
-- line, stamping the waybill, opening discrepancies and writing the audit
-- rows either all happen or none of them do. Loop this in application code
-- and a dropped connection at line 40 of 60 leaves assets belonging to no
-- register at all, with nothing to tell you which ones.
-- ============================================================================

do $$ begin
  create type app.transfer_status as enum
    ('draft','pending','approved','in_transit','received','cancelled','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.discrepancy_kind as enum
    ('short','damaged','wrong_item','surplus');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.discrepancy_outcome as enum
    ('found','written_off','charged_to_carrier');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------- gap-free numbering ------
-- Sequences skip on rollback, which is fine for surrogate keys and useless
-- for documents: an auditor asking why WB-2026-0147 does not exist is not
-- satisfied by "the transaction failed". A counter row locked FOR UPDATE
-- serialises issuance per company and leaves no holes.
create table if not exists app.doc_counters (
  company_id uuid not null references app.companies(id) on delete cascade,
  kind       text not null check (kind in ('waybill','po','disposal','import','claim')),
  year       int  not null,
  last_value int  not null default 0,
  primary key (company_id, kind, year)
);

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

-- ----------------------------------------------------------- transfers -----
create table if not exists app.transfers (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references app.companies(id) on delete cascade,
  reference      text not null,
  from_location  uuid not null references app.locations(id) on delete restrict,
  to_location    uuid not null references app.locations(id) on delete restrict,
  status         app.transfer_status not null default 'draft',
  reason         text,
  notes          text,
  driver_name    text,
  vehicle_reg    text,
  waybill_no     text,
  waybill_issued_at timestamptz,
  waybill_revision  int not null default 1 check (waybill_revision >= 1),
  expected_on    date,
  requested_by   uuid references app.profiles(id),
  dispatched_at  timestamptz,
  received_at    timestamptz,
  received_by    uuid references app.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint transfers_ref_uq unique (company_id, reference),
  constraint transfers_waybill_uq unique (company_id, waybill_no),
  constraint transfers_endpoints_ck check (from_location <> to_location),
  -- once dispatched a waybill must exist; before that it must not
  constraint transfers_waybill_ck check (
    (status in ('draft','pending','approved','cancelled','rejected') and waybill_no is null)
    or (status in ('in_transit','received') and waybill_no is not null)
  )
);

create index if not exists transfers_company_status_idx
  on app.transfers (company_id, status);
create index if not exists transfers_to_idx on app.transfers (to_location)
  where status = 'in_transit';

create table if not exists app.transfer_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references app.companies(id) on delete cascade,
  transfer_id uuid not null references app.transfers(id) on delete cascade,
  asset_id    uuid not null references app.assets(id) on delete restrict,
  received    boolean,           -- null until the delivery is accepted
  flagged     boolean not null default false,
  flag_note   text,
  unique (transfer_id, asset_id)
);

create index if not exists transfer_lines_transfer_idx on app.transfer_lines (transfer_id);

-- -------------------------------------------------------- discrepancies ----
create table if not exists app.discrepancies (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  reference     text not null,
  transfer_id   uuid references app.transfers(id) on delete set null,
  asset_id      uuid references app.assets(id) on delete set null,
  kind          app.discrepancy_kind not null,
  note          text,
  owner_id      uuid references app.profiles(id),
  opened_at     timestamptz not null default now(),
  resolved_at   timestamptz,
  outcome       app.discrepancy_outcome,
  outcome_note  text,
  unique (company_id, reference),
  constraint discrepancy_resolution_ck check (
    (resolved_at is null and outcome is null)
    or (resolved_at is not null and outcome is not null)
  )
);

create index if not exists discrepancies_open_idx
  on app.discrepancies (company_id) where resolved_at is null;

-- ========================================================== operations =====

-- Issue the waybill and put the assets in transit. From this moment the
-- assets belong to neither register.
create or replace function app.dispatch_transfer(p_transfer uuid)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t   app.transfers%rowtype;
  v_wb  text;
  v_n   int;
begin
  select * into v_t from app.transfers where id = p_transfer for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'no_data_found';
  end if;
  if not app.can_access_location(v_t.company_id, v_t.from_location) then
    raise exception 'you cannot dispatch from that location' using errcode = '42501';
  end if;
  if v_t.status <> 'approved' then
    raise exception 'transfer % is %, not approved', v_t.reference, v_t.status
      using errcode = 'check_violation';
  end if;

  -- Every asset must still be where the transfer says it is. If one moved
  -- since approval, stop: silently dispatching a stale line is how a register
  -- ends up describing a world that no longer exists.
  select count(*) into v_n
  from app.transfer_lines tl
  join app.assets a on a.id = tl.asset_id
  where tl.transfer_id = p_transfer
    and (a.location_id is distinct from v_t.from_location or a.status <> 'active');
  if v_n > 0 then
    raise exception '% asset(s) are no longer available at the origin', v_n
      using errcode = 'check_violation',
            hint = 'Re-check the manifest: something moved or went for repair after approval.';
  end if;

  v_wb := app.next_doc_number(v_t.company_id, 'waybill');

  update app.assets a
     set status = 'transit', location_id = null, holder = 'Pending receipt'
    from app.transfer_lines tl
   where tl.transfer_id = p_transfer and a.id = tl.asset_id;

  update app.transfers
     set status = 'in_transit', waybill_no = v_wb,
         waybill_issued_at = now(), dispatched_at = now()
   where id = p_transfer;

  select count(*) into v_n from app.transfer_lines where transfer_id = p_transfer;

  perform app.log(v_t.company_id, 'dispatched consignment', 'transfers',
    p_transfer::text, v_wb,
    format('%s asset(s) from %s, waybill issued and frozen', v_n,
      (select name from app.locations where id = v_t.from_location)),
    'info', v_t.from_location);

  return v_wb;
end $$;

-- ---------------------------------------------------------------------------
-- The one that matters. Accepting a delivery moves every unflagged line onto
-- the destination register, opens a discrepancy for each flagged one, stamps
-- the waybill received and writes the audit rows — in a single transaction.
--
-- p_flagged: asset ids the receiving manager physically could not confirm.
--            Everything else is treated as present.
-- ---------------------------------------------------------------------------
create or replace function app.accept_transfer(
  p_transfer uuid,
  p_flagged  uuid[] default '{}',
  p_notes    text   default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_t        app.transfers%rowtype;
  v_accepted int := 0;
  v_flagged  int := 0;
  v_dest     text;
  v_line     record;
  v_ref      text;
  v_outstanding int;
begin
  select * into v_t from app.transfers where id = p_transfer for update;
  if not found then
    raise exception 'transfer not found' using errcode = 'no_data_found';
  end if;
  if not app.is_member(v_t.company_id) then
    raise exception 'no access to this company' using errcode = '42501';
  end if;
  -- Only someone who can act at the destination may confirm what arrived
  -- there. That is the entire point of the step.
  if not app.can_access_location(v_t.company_id, v_t.to_location) then
    raise exception 'only a manager at the destination can accept this delivery'
      using errcode = '42501';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'transfer % is %, so there is nothing to accept',
      v_t.reference, v_t.status using errcode = 'check_violation';
  end if;

  -- A partial receipt leaves the transfer in_transit while a discrepancy is
  -- open, so status alone does not prove there is anything left to do. Every
  -- line already decided must stay decided: re-running this must not re-accept
  -- received lines or open a second discrepancy for the same asset.
  if not exists (
    select 1 from app.transfer_lines tl
    where tl.transfer_id = p_transfer and tl.received is null
  ) then
    raise exception 'every line on % has already been received or flagged', v_t.reference
      using errcode = 'check_violation',
            hint = 'Resolve the open discrepancies instead of accepting again.';
  end if;

  select name into v_dest from app.locations where id = v_t.to_location;

  for v_line in
    select tl.id, tl.asset_id, a.tag, a.name
    from app.transfer_lines tl
    join app.assets a on a.id = tl.asset_id
    where tl.transfer_id = p_transfer
      and tl.received is null          -- only lines not yet decided
    order by a.tag
  loop
    if v_line.asset_id = any(p_flagged) then
      -- Stays in transit and becomes somebody's problem, with a clock on it.
      v_ref := 'DSC-' || substr(replace(gen_random_uuid()::text,'-',''), 1, 8);

      update app.transfer_lines
         set received = false, flagged = true, flag_note = p_notes
       where id = v_line.id;

      insert into app.discrepancies
        (company_id, reference, transfer_id, asset_id, kind, note, owner_id)
      values
        (v_t.company_id, v_ref, p_transfer, v_line.asset_id, 'short',
         coalesce(p_notes, 'Flagged on receipt at ' || v_dest), auth.uid());

      v_flagged := v_flagged + 1;

      perform app.log(v_t.company_id, 'flagged a delivery line', 'assets',
        v_line.asset_id::text, v_line.tag,
        format('%s not confirmed on arrival at %s — discrepancy %s opened',
               v_line.name, v_dest, v_ref),
        'warn', v_t.to_location);
    else
      update app.assets
         set status = 'active', location_id = v_t.to_location,
             holder = 'Received at ' || v_dest
       where id = v_line.asset_id;

      update app.transfer_lines
         set received = true, flagged = false
       where id = v_line.id;

      v_accepted := v_accepted + 1;
    end if;
  end loop;

  if v_accepted = 0 and v_flagged = 0 then
    raise exception 'transfer % has no lines', v_t.reference
      using errcode = 'check_violation';
  end if;

  -- The waybill closes only when nothing anywhere on it is outstanding —
  -- not merely when this particular call flagged nothing.
  select count(*) into v_outstanding
  from app.transfer_lines tl
  where tl.transfer_id = p_transfer
    and (tl.received is null or tl.flagged);

  update app.transfers
     set status       = (case when v_outstanding = 0 then 'received' else 'in_transit' end)::app.transfer_status,
         received_at  = case when v_outstanding = 0 then now() else null end,
         received_by  = case when v_outstanding = 0 then auth.uid() else null end,
         notes        = coalesce(p_notes, notes)
   where id = p_transfer;

  perform app.log(v_t.company_id, 'accepted delivery', 'transfers',
    p_transfer::text, v_t.waybill_no,
    format('%s asset(s) moved to %s%s', v_accepted, v_dest,
      case when v_flagged > 0
        then format(', %s held as a discrepancy', v_flagged) else '' end),
    case when v_flagged > 0 then 'warn'::app.audit_tone else 'ok'::app.audit_tone end,
    v_t.to_location);

  return jsonb_build_object(
    'transfer_id', p_transfer,
    'waybill',     v_t.waybill_no,
    'accepted',    v_accepted,
    'flagged',     v_flagged,
    'status',      case when v_outstanding = 0 then 'received' else 'in_transit' end,
    'outstanding', v_outstanding);
end $$;

comment on function app.accept_transfer is
  'Atomically receives a consignment. All lines move, or none do.';

-- ------------------------------------------------- resolving a discrepancy -
create or replace function app.resolve_discrepancy(
  p_discrepancy uuid,
  p_outcome     app.discrepancy_outcome,
  p_note        text default null
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_d app.discrepancies%rowtype; v_t app.transfers%rowtype; v_open int;
begin
  select * into v_d from app.discrepancies where id = p_discrepancy for update;
  if not found then
    raise exception 'discrepancy not found' using errcode = 'no_data_found';
  end if;
  if v_d.resolved_at is not null then
    raise exception 'discrepancy % is already resolved', v_d.reference
      using errcode = 'check_violation';
  end if;
  if not app.has_role(v_d.company_id, 'owner','admin','manager') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_t from app.transfers where id = v_d.transfer_id;

  if p_outcome = 'found' then
    update app.assets set status = 'active', location_id = v_t.to_location,
           holder = 'Received late'
     where id = v_d.asset_id;
  else
    update app.assets set status = 'retired', location_id = (
        select id from app.locations
        where company_id = v_d.company_id and kind = 'virtual'),
           holder = null, disposed_on = current_date,
           disposal_reason = case p_outcome
             when 'written_off' then 'lost'::app.disposal_reason
             else 'lost'::app.disposal_reason end
     where id = v_d.asset_id;
  end if;

  update app.transfer_lines
     set received = (p_outcome = 'found'), flagged = false
   where transfer_id = v_d.transfer_id and asset_id = v_d.asset_id;

  update app.discrepancies
     set resolved_at = now(), outcome = p_outcome, outcome_note = p_note
   where id = p_discrepancy;

  -- Close the waybill if this was the last thing outstanding on it.
  select count(*) into v_open from app.discrepancies
   where transfer_id = v_d.transfer_id and resolved_at is null;
  if v_open = 0 and v_t.id is not null then
    update app.transfers set status = 'received', received_at = now(),
           received_by = auth.uid()
     where id = v_t.id and status = 'in_transit';
  end if;

  perform app.log(v_d.company_id, 'resolved discrepancy', 'discrepancies',
    p_discrepancy::text, v_d.reference,
    format('outcome: %s%s', p_outcome, coalesce(' — ' || p_note, '')),
    case p_outcome when 'found' then 'ok'::app.audit_tone
                   else 'warn'::app.audit_tone end);
end $$;

-- ------------------------------------------------------ archiving a site ---
-- Locations archive, they never delete. Waybills, asset histories and audit
-- rows all reference a location by id; dropping the row turns every one of
-- those into a dangling pointer and quietly breaks the trail.
create or replace function app.archive_location(p_location uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_l app.locations%rowtype; v_assets int; v_moves int;
begin
  select * into v_l from app.locations where id = p_location for update;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_l.company_id, 'owner','admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if v_l.kind = 'virtual' then
    raise exception 'the virtual warehouse cannot be archived'
      using errcode = 'check_violation',
            hint = 'It is where swept, retired and unassigned assets live.';
  end if;

  select count(*) into v_assets from app.assets
   where location_id = p_location and status <> 'retired';
  if v_assets > 0 then
    raise exception 'location still holds % asset(s)', v_assets
      using errcode = 'check_violation',
            hint = 'Sweep the contents to the virtual warehouse first.';
  end if;

  select count(*) into v_moves from app.transfers
   where (from_location = p_location or to_location = p_location)
     and status in ('pending','approved','in_transit');
  if v_moves > 0 then
    raise exception '% consignment(s) to or from here are still open', v_moves
      using errcode = 'check_violation',
            hint = 'An asset cannot be moved while it is already moving.';
  end if;

  update app.locations
     set archived_at = now(), archived_by = auth.uid()
   where id = p_location;

  perform app.log(v_l.company_id, 'archived location', 'locations',
    p_location::text, v_l.name,
    'Hidden from pickers and reports; still resolves in history', 'warn', p_location);
end $$;

-- Move everything at a location into the virtual warehouse so it can be archived.
create or replace function app.sweep_location(p_location uuid)
returns int
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_l app.locations%rowtype; v_vw uuid; v_n int;
begin
  select * into v_l from app.locations where id = p_location;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_l.company_id, 'owner','admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select id into v_vw from app.locations
   where company_id = v_l.company_id and kind = 'virtual';

  update app.assets
     set location_id = v_vw, status = 'idle', holder = null
   where location_id = p_location and status not in ('retired','transit');
  get diagnostics v_n = row_count;

  perform app.log(v_l.company_id, 'swept location', 'locations',
    p_location::text, v_l.name,
    format('%s asset(s) moved to the virtual warehouse', v_n), 'warn', p_location);

  return v_n;
end $$;

-- ---------------------------------------------------------------- RLS ------
alter table app.transfers      enable row level security;
alter table app.transfer_lines enable row level security;
alter table app.discrepancies  enable row level security;
alter table app.doc_counters   enable row level security;

alter table app.transfers      force row level security;
alter table app.transfer_lines force row level security;
alter table app.discrepancies  force row level security;
alter table app.doc_counters   force row level security;

-- A transfer is visible to anyone who can act at either end of it.
drop policy if exists transfers_select on app.transfers;
create policy transfers_select on app.transfers
  for select using (
    app.is_member(company_id)
    and ( app.can_access_location(company_id, from_location)
       or app.can_access_location(company_id, to_location) )
  );

drop policy if exists transfers_insert on app.transfers;
create policy transfers_insert on app.transfers
  for insert with check (
    app.can_write(company_id)
    and app.can_access_location(company_id, from_location)
  );

drop policy if exists transfers_update on app.transfers;
create policy transfers_update on app.transfers
  for update
  using      ( app.can_write(company_id)
               and ( app.can_access_location(company_id, from_location)
                  or app.can_access_location(company_id, to_location) ) )
  with check ( app.can_write(company_id)
               and ( app.can_access_location(company_id, from_location)
                  or app.can_access_location(company_id, to_location) ) );

drop policy if exists transfer_lines_select on app.transfer_lines;
create policy transfer_lines_select on app.transfer_lines
  for select using (
    exists (select 1 from app.transfers t
            where t.id = transfer_id and app.is_member(t.company_id))
  );

drop policy if exists transfer_lines_write on app.transfer_lines;
create policy transfer_lines_write on app.transfer_lines
  for insert with check ( app.can_write(company_id) );

drop policy if exists transfer_lines_update on app.transfer_lines;
create policy transfer_lines_update on app.transfer_lines
  for update
  using      ( app.can_write(company_id) )
  with check ( app.can_write(company_id) );

drop policy if exists discrepancies_select on app.discrepancies;
create policy discrepancies_select on app.discrepancies
  for select using ( app.is_member(company_id) );

drop policy if exists discrepancies_insert on app.discrepancies;
create policy discrepancies_insert on app.discrepancies
  for insert with check ( app.can_write(company_id) );

drop policy if exists discrepancies_update on app.discrepancies;
create policy discrepancies_update on app.discrepancies
  for update
  using      ( app.has_role(company_id, 'owner','admin','manager') )
  with check ( app.has_role(company_id, 'owner','admin','manager') );

drop policy if exists doc_counters_select on app.doc_counters;
create policy doc_counters_select on app.doc_counters
  for select using ( app.is_member(company_id) );
-- No write policy: numbers come from app.next_doc_number() only.

-- ------------------------------------------------------------- audit -------
drop trigger if exists audit_transfers on app.transfers;
create trigger audit_transfers after insert or update or delete on app.transfers
  for each row execute function app.audit_row_change('reference', 'to_location');

drop trigger if exists audit_discrepancies on app.discrepancies;
create trigger audit_discrepancies after insert or update on app.discrepancies
  for each row execute function app.audit_row_change('reference', '');

drop trigger if exists touch_transfers on app.transfers;
create trigger touch_transfers before update on app.transfers
  for each row execute function app.touch_updated_at();
