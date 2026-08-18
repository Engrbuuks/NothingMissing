-- ============================================================================
-- 0008_field_links.sql
-- Location links and field submissions.
--
-- This is the part of the product that is actually unusual, so it is worth
-- being explicit about the threat model.
--
-- A link holder has NO account and NO password. They hold a URL. That URL is
-- sent over WhatsApp, will be forwarded, will sit in a phone that gets lost,
-- and will end up in a screenshot. Every design decision below assumes the
-- URL is public knowledge:
--
--   * The token is stored HASHED. A database leak does not hand anyone a
--     working link, the same reason password hashes exist.
--   * A link grants a narrow verb set at ONE location. It can never read the
--     register, see costs, see another site, export, or approve.
--   * Nothing a link submits changes anything. It creates a pending row that
--     a manager reviews. The blast radius of a stolen link is therefore
--     "somebody submitted a wrong count", not "somebody moved our generators".
--   * Links expire, carry a submission ceiling, and revoke instantly.
--
-- The counting rule that matters: a submission never shows the counter what
-- the system expects. If it did they would agree with it, and the count would
-- be worthless. The comparison happens only on the reviewer's screen.
-- ============================================================================

do $$ begin
  create type app.link_verb as enum
    ('count','fault','transfer_request','confirm_delivery','meter_reading');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.submission_kind as enum
    ('count','fault','transfer_request','delivery','meter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.submission_status as enum
    ('pending','accepted','partial','rejected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------- the holders ----
-- People who touch the assets but will never have a seat: storekeepers,
-- drivers, site crew. Making them buy a licence is exactly why registers go
-- stale, so they are first-class here without being users.
create table if not exists app.link_holders (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references app.companies(id) on delete cascade,
  name         text not null,
  role_label   text,                      -- 'Storekeeper', 'Driver'
  phone        text,
  location_id  uuid not null references app.locations(id) on delete restrict,
  created_at   timestamptz not null default now(),
  -- accuracy record, maintained by the review process, never typed in
  submissions_total   int not null default 0,
  submissions_clean   int not null default 0,
  variance_sum_pct    numeric(10,3) not null default 0
);

create index if not exists holders_company_idx on app.link_holders (company_id);

-- --------------------------------------------------------------- links -----
create table if not exists app.location_links (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  location_id   uuid not null references app.locations(id) on delete restrict,
  holder_id     uuid references app.link_holders(id) on delete set null,
  slug          text not null,
  -- never the token itself
  token_hash    text not null,
  verbs         app.link_verb[] not null check (cardinality(verbs) between 1 and 5),
  expires_on    date not null,
  max_per_month int,
  used_count    int not null default 0,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid references app.profiles(id),
  created_by    uuid references app.profiles(id),
  created_at    timestamptz not null default now(),
  unique (company_id, slug)
);

create unique index if not exists links_token_idx on app.location_links (token_hash);
create index if not exists links_live_idx on app.location_links (company_id)
  where revoked_at is null;

-- --------------------------------------------------------- submissions -----
create table if not exists app.submissions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references app.companies(id) on delete cascade,
  reference     text not null,
  link_id       uuid references app.location_links(id) on delete set null,
  holder_id     uuid references app.link_holders(id) on delete set null,
  location_id   uuid not null references app.locations(id) on delete restrict,
  kind          app.submission_kind not null,
  status        app.submission_status not null default 'pending',
  note          text,
  -- what the device reported, kept for attribution
  device_label  text,
  submitted_at  timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid references app.profiles(id),
  -- fault and transfer submissions point at an asset
  asset_id      uuid references app.assets(id) on delete set null,
  fault_kind    text,
  dest_location uuid references app.locations(id) on delete set null,
  meter_value   numeric(12,2),
  count_id      uuid references app.stock_counts(id) on delete set null,
  unique (company_id, reference)
);

create index if not exists submissions_pending_idx
  on app.submissions (company_id, location_id) where status = 'pending';

-- ===================================================== issuing a link =======
-- Returns the token ONCE. It is never retrievable afterwards, because only
-- the hash is stored — the same reason you cannot be shown your own password.
create or replace function app.issue_location_link(
  p_company   uuid,
  p_location  uuid,
  p_holder    uuid,
  p_verbs     app.link_verb[],
  p_expires   date default (current_date + 90),
  p_max_month int default 50
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_token text;
  v_slug  text;
  v_id    uuid;
  v_name  text;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'only an owner or admin can issue a location link'
      using errcode = '42501';
  end if;
  if not exists (select 1 from app.locations
                 where id = p_location and company_id = p_company
                   and archived_at is null) then
    raise exception 'no such live location in this company'
      using errcode = 'foreign_key_violation';
  end if;
  if p_expires <= current_date then
    raise exception 'a link must expire in the future' using errcode = 'check_violation';
  end if;

  select name into v_name from app.link_holders where id = p_holder;

  -- 32 random bytes. Guessing is not a threat worth modelling at this length.
  v_token := encode(gen_random_bytes(24), 'hex');
  v_slug  := lower(regexp_replace(coalesce(v_name, 'link'), '[^a-zA-Z0-9]+', '-', 'g'))
             || '-' || substr(md5(gen_random_uuid()::text), 1, 6);

  insert into app.location_links
    (company_id, location_id, holder_id, slug, token_hash, verbs,
     expires_on, max_per_month, created_by)
  values
    (p_company, p_location, p_holder, v_slug,
     encode(digest(v_token, 'sha256'), 'hex'), p_verbs,
     p_expires, p_max_month, auth.uid())
  returning id into v_id;

  perform app.log(p_company, 'issued a location link', 'location_links',
    v_id::text, v_slug,
    format('%s at %s, verbs: %s, expires %s', coalesce(v_name, 'unnamed'),
      (select name from app.locations where id = p_location),
      array_to_string(p_verbs::text[], ', '), p_expires),
    'warn', p_location);

  return jsonb_build_object(
    'link_id', v_id,
    'slug',    v_slug,
    'token',   v_token,     -- shown once, never again
    'url',     format('/l/%s#%s', v_slug, v_token));
end $$;

comment on function app.issue_location_link is
  'Issues a scoped link. The token is returned once and only its hash is stored.';

create or replace function app.revoke_location_link(p_link uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_l app.location_links%rowtype;
begin
  select * into v_l from app.location_links where id = p_link;
  if not found then
    raise exception 'link not found' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_l.company_id, 'owner','admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  update app.location_links
     set revoked_at = now(), revoked_by = auth.uid()
   where id = p_link;
  perform app.log(v_l.company_id, 'revoked a location link', 'location_links',
    p_link::text, v_l.slug, coalesce(p_reason, 'no reason given'), 'warn', v_l.location_id);
end $$;

-- Resolve a presented token. Returns nothing at all for an expired, revoked,
-- over-quota or unknown token — the caller cannot distinguish which, so a
-- probe learns nothing.
create or replace function app.resolve_link(p_token text)
returns table (link_id uuid, company_id uuid, location_id uuid,
               holder_id uuid, verbs app.link_verb[])
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select l.id, l.company_id, l.location_id, l.holder_id, l.verbs
  from app.location_links l
  where l.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and l.revoked_at is null
    and l.expires_on >= current_date
    and (l.max_per_month is null or l.used_count < l.max_per_month)
$$;

-- ================================================== submitting from field ===
-- SECURITY DEFINER and callable by anon, because the submitter has no account.
-- Everything it can do is bounded by the link it presents.
create or replace function app.submit_from_link(
  p_token   text,
  p_kind    app.submission_kind,
  p_note    text default null,
  p_device  text default null,
  p_lines   jsonb default null,      -- [{"sku":"CON-AGO-001","qty":3910}, ...]
  p_asset   uuid default null,
  p_fault   text default null,
  p_dest    uuid default null,
  p_meter   numeric default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_link   record;
  v_verb   app.link_verb;
  v_sub    uuid;
  v_ref    text;
  v_count  uuid;
  v_line   jsonb;
  v_item   app.stock_items%rowtype;
  v_lines  int := 0;
begin
  select * into v_link from app.resolve_link(p_token);
  if not found then
    -- Deliberately vague: an expired, revoked, unknown and over-quota token
    -- all say the same thing.
    raise exception 'this link is no longer valid'
      using errcode = '42501',
            hint = 'Ask your manager for a new link.';
  end if;

  v_verb := case p_kind
              when 'count'            then 'count'
              when 'fault'            then 'fault'
              when 'transfer_request' then 'transfer_request'
              when 'delivery'         then 'confirm_delivery'
              when 'meter'            then 'meter_reading'
            end::app.link_verb;

  if not (v_verb = any(v_link.verbs)) then
    raise exception 'this link cannot do that' using errcode = '42501';
  end if;

  -- An asset named in a submission must be at the link's own location.
  if p_asset is not null and not exists (
    select 1 from app.assets a
    where a.id = p_asset and a.company_id = v_link.company_id
      and a.location_id = v_link.location_id
  ) then
    raise exception 'that asset is not at this location' using errcode = '42501';
  end if;

  v_ref := app.next_doc_number(v_link.company_id, 'submission');

  insert into app.submissions
    (company_id, reference, link_id, holder_id, location_id, kind,
     note, device_label, asset_id, fault_kind, dest_location, meter_value)
  values
    (v_link.company_id, v_ref, v_link.link_id, v_link.holder_id,
     v_link.location_id, p_kind, p_note, p_device, p_asset, p_fault, p_dest, p_meter)
  returning id into v_sub;

  if p_kind = 'count' and p_lines is not null then
    insert into app.stock_counts
      (company_id, location_id, reference, status, counted_by, submitted_at, note)
    values
      (v_link.company_id, v_link.location_id,
       app.next_doc_number(v_link.company_id, 'count'), 'submitted',
       (select name from app.link_holders where id = v_link.holder_id),
       now(), p_note)
    returning id into v_count;

    for v_line in select * from jsonb_array_elements(p_lines) loop
      select * into v_item from app.stock_items
       where company_id = v_link.company_id and sku = v_line ->> 'sku';
      continue when not found;
      -- A missing quantity means "not counted", which is not the same as zero.
      continue when (v_line ->> 'qty') is null;

      insert into app.stock_count_lines
        (company_id, count_id, item_id, book_qty, counted_qty)
      values
        (v_link.company_id, v_count, v_item.id,
         app.stock_balance(v_item.id, v_link.location_id),
         (v_line ->> 'qty')::numeric);
      v_lines := v_lines + 1;
    end loop;

    update app.submissions set count_id = v_count where id = v_sub;
  end if;

  update app.location_links
     set used_count = used_count + 1, last_used_at = now()
   where id = v_link.link_id;

  update app.link_holders
     set submissions_total = submissions_total + 1
   where id = v_link.holder_id;

  -- Attribute the audit row to the link, not to a user, since there is none.
  perform set_config('app.actor_label',
    coalesce((select name from app.link_holders where id = v_link.holder_id),
             'Link holder'), true);
  perform set_config('app.actor_kind', 'link', true);

  perform app.log(v_link.company_id, 'received a field submission', 'submissions',
    v_sub::text, v_ref,
    format('%s from %s via a location link%s', p_kind,
      coalesce((select name from app.link_holders where id = v_link.holder_id), 'unknown'),
      case when v_lines > 0 then format(', %s line(s) counted', v_lines) else '' end),
    'info', v_link.location_id);

  -- The submitter is told it is pending, never that it is live.
  return jsonb_build_object(
    'reference', v_ref,
    'status',    'pending',
    'lines',     v_lines,
    'message',   'Sent for review. Nothing on the register changes until your manager confirms it.');
end $$;

-- ===================================================== reviewing one ========
create or replace function app.review_submission(
  p_submission uuid,
  p_accept     boolean,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_s      app.submissions%rowtype;
  v_result jsonb := '{}'::jsonb;
  v_var    numeric := 0;
  v_lines  int := 0;
  v_off    int := 0;
begin
  select * into v_s from app.submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'no_data_found';
  end if;
  if v_s.status <> 'pending' then
    raise exception 'submission % has already been reviewed', v_s.reference
      using errcode = 'check_violation';
  end if;
  if not app.has_role(v_s.company_id, 'owner','admin','manager') then
    raise exception 'only a manager can review field submissions'
      using errcode = '42501';
  end if;
  if not app.can_access_location(v_s.company_id, v_s.location_id) then
    raise exception 'not your location' using errcode = '42501';
  end if;

  if not p_accept then
    update app.submissions
       set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
           note = coalesce(p_note, note)
     where id = p_submission;
    perform app.log(v_s.company_id, 'rejected a field submission', 'submissions',
      p_submission::text, v_s.reference, coalesce(p_note, 'no reason given'),
      'warn', v_s.location_id);
    return jsonb_build_object('status','rejected');
  end if;

  if v_s.kind = 'count' and v_s.count_id is not null then
    -- Measure accuracy before posting, while the book figures still stand.
    select count(*), count(*) filter (where counted_qty <> book_qty),
           coalesce(avg(case when book_qty > 0
                        then abs(counted_qty - book_qty) / book_qty * 100 else 0 end), 0)
      into v_lines, v_off, v_var
    from app.stock_count_lines where count_id = v_s.count_id;

    update app.stock_count_lines set accepted = true where count_id = v_s.count_id;
    v_result := app.post_stock_count(v_s.count_id);

  elsif v_s.kind = 'fault' and v_s.asset_id is not null then
    -- The asset comes off active duty immediately, so nobody requisitions
    -- something that is sitting in a corner unusable.
    update app.assets set status = 'repair' where id = v_s.asset_id;
    v_result := jsonb_build_object('asset_marked','repair');

  elsif v_s.kind = 'meter' and v_s.asset_id is not null then
    update app.assets set meter_value = greatest(meter_value, coalesce(v_s.meter_value, 0))
     where id = v_s.asset_id;
    v_result := jsonb_build_object('meter', v_s.meter_value);
  end if;

  update app.submissions
     set status = 'accepted', reviewed_at = now(), reviewed_by = auth.uid()
   where id = p_submission;

  -- The accuracy record is a by-product of reviewing, never typed in. It is
  -- what tells you whose figures to spot-check.
  if v_s.holder_id is not null and v_s.kind = 'count' then
    update app.link_holders
       set submissions_clean = submissions_clean + (case when v_off = 0 then 1 else 0 end),
           variance_sum_pct  = variance_sum_pct + v_var
     where id = v_s.holder_id;
  end if;

  perform app.log(v_s.company_id, 'accepted a field submission', 'submissions',
    p_submission::text, v_s.reference,
    format('%s from %s%s', v_s.kind,
      coalesce((select name from app.link_holders where id = v_s.holder_id), 'unknown'),
      case when v_lines > 0
        then format(' — %s line(s), %s differing', v_lines, v_off) else '' end),
    case when v_off > 0 then 'warn'::app.audit_tone else 'ok'::app.audit_tone end,
    v_s.location_id);

  return v_result || jsonb_build_object('status','accepted','lines',v_lines,'variances',v_off);
end $$;

-- A holder's accuracy, computed rather than asserted.
create or replace function app.holder_accuracy(p_holder uuid)
returns jsonb
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select jsonb_build_object(
    'name',            h.name,
    'submissions',     h.submissions_total,
    'clean',           h.submissions_clean,
    'clean_pct',       case when h.submissions_total > 0
                         then round(h.submissions_clean::numeric
                                    / h.submissions_total * 100, 1) else null end,
    'avg_variance_pct',case when h.submissions_total > 0
                         then round(h.variance_sum_pct / h.submissions_total, 2) else null end)
  from app.link_holders h
  where h.id = p_holder and app.is_member(h.company_id)
$$;

-- ---------------------------------------------------------------- RLS ------
alter table app.link_holders   enable row level security;
alter table app.location_links enable row level security;
alter table app.submissions    enable row level security;

alter table app.link_holders   force row level security;
alter table app.location_links force row level security;
alter table app.submissions    force row level security;

drop policy if exists holders_select on app.link_holders;
create policy holders_select on app.link_holders
  for select using ( app.is_member(company_id) );

drop policy if exists holders_insert on app.link_holders;
create policy holders_insert on app.link_holders
  for insert with check ( app.has_role(company_id, 'owner','admin','manager') );

drop policy if exists holders_update on app.link_holders;
create policy holders_update on app.link_holders
  for update
  using      ( app.has_role(company_id, 'owner','admin','manager') )
  with check ( app.has_role(company_id, 'owner','admin','manager') );

-- Only owners and admins ever see the link rows, and the token hash is
-- useless to them anyway.
drop policy if exists links_select on app.location_links;
create policy links_select on app.location_links
  for select using ( app.has_role(company_id, 'owner','admin') );

drop policy if exists submissions_select on app.submissions;
create policy submissions_select on app.submissions
  for select using (
    app.is_member(company_id) and app.can_access_location(company_id, location_id)
  );

-- Nothing writes here directly. Links go through issue/revoke, submissions
-- through submit_from_link(), reviews through review_submission().
revoke insert, update, delete on app.location_links from authenticated, anon;
revoke insert, update, delete on app.submissions    from authenticated, anon;

-- The field page is unauthenticated by design, so anon needs exactly these two
-- and nothing else.
grant execute on function app.submit_from_link(text, app.submission_kind, text, text,
  jsonb, uuid, text, uuid, numeric) to anon;
grant execute on function app.resolve_link(text) to anon;

drop trigger if exists audit_submissions on app.submissions;
create trigger audit_submissions after update on app.submissions
  for each row execute function app.audit_row_change('reference', 'location_id');

alter table app.doc_counters drop constraint if exists doc_counters_kind_check;
alter table app.doc_counters add constraint doc_counters_kind_check
  check (kind in ('waybill','po','disposal','import','claim','request','count','submission'));

create or replace function app.next_doc_number(p_company uuid, p_kind text)
returns text
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_year int := extract(year from now())::int;
  v_next int;
  v_pfx  text := case p_kind
                   when 'waybill'    then 'WB'
                   when 'po'         then 'PO'
                   when 'disposal'   then 'DSP'
                   when 'import'     then 'IMP'
                   when 'claim'      then 'CLM'
                   when 'request'    then 'REQ'
                   when 'count'      then 'SC'
                   when 'submission' then 'SUB'
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
