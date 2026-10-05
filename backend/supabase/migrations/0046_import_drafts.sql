-- ============================================================================
-- 0046_import_drafts.sql
-- The sheet stops travelling in the address bar.
--
-- previewBranchImport redirected to the review page with the whole spreadsheet
-- in the query string:
--
--     const qs = new URLSearchParams({ branch, existing, city, sheet: raw });
--     redirect('/import/review?' + qs.toString());
--
-- Which works, until it does not. Percent encoding turns every comma and
-- newline into three bytes, so a 4 KB file becomes a 5.7 KB URL and a header
-- cap of 16 KB is reached at around 170 rows. A register of a few hundred lines
-- is the ordinary case, not the extreme one.
--
-- What makes it worth a migration rather than a shrug is the shape of the
-- failure. An over-long Location header does not report that the file was too
-- big; the navigation simply does not happen. The person presses Preview and
-- nothing moves. The same symptom, and the same wasted afternoon, as the
-- import timeout this pair of migrations was written to fix.
--
-- So the sheet is parked for a few hours and the URL carries a token. The row
-- is the person's own, readable by nobody else, including other members of
-- their own company: a half checked import is not yet anybody's business.
-- ============================================================================

create table if not exists app.import_drafts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references app.companies(id) on delete cascade,
  user_id    uuid not null default auth.uid(),
  kind       text not null check (kind in ('assets', 'stock')),
  sheet      text not null check (length(sheet) <= 2000000),
  branch     text,
  existing   uuid references app.locations(id) on delete set null,
  city       text,
  where_name text,
  created_at timestamptz not null default now()
);

comment on table app.import_drafts is
  'A pasted spreadsheet held between the preview and the commit, so the review '
  'page can be reached by a short URL. Nothing here has been imported. Rows '
  'older than a few hours are removed when the next draft is made.';

create index if not exists import_drafts_stale_idx on app.import_drafts (created_at);

alter table app.import_drafts enable row level security;
alter table app.import_drafts force row level security;

-- Own drafts only. A draft is an unfinished thought, and the register is where
-- a company's shared view of its assets lives.
drop policy if exists import_drafts_select on app.import_drafts;
create policy import_drafts_select on app.import_drafts
  for select using (user_id = auth.uid() and app.is_member(company_id));

drop policy if exists import_drafts_insert on app.import_drafts;
create policy import_drafts_insert on app.import_drafts
  for insert with check (user_id = auth.uid() and app.can_write(company_id));

drop policy if exists import_drafts_delete on app.import_drafts;
create policy import_drafts_delete on app.import_drafts
  for delete using (user_id = auth.uid() and app.is_member(company_id));

-- No update policy. A draft is written once and read once; editing one in place
-- would mean the preview and the commit could disagree about what was checked.

/* -------------------------------------------------------------------------- *
 * Parking a sheet.
 *
 * Returns the id to put in the URL. Takes the opportunity to clear out stale
 * drafts, which keeps the table from growing without a scheduled job: an
 * import is rare enough that the extra delete costs nothing, and frequent
 * enough that nothing lingers for long.
 * -------------------------------------------------------------------------- */
create or replace function app.park_import_draft(
  p_company    uuid,
  p_kind       text,
  p_sheet      text,
  p_branch     text default null,
  p_existing   uuid default null,
  p_city       text default null,
  p_where_name text default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_id uuid;
begin
  if not app.can_write(p_company) then
    raise exception 'not permitted to import' using errcode = '42501';
  end if;
  if p_kind not in ('assets', 'stock') then
    raise exception 'unknown import kind' using errcode = '22023';
  end if;
  if coalesce(btrim(p_sheet), '') = '' then
    raise exception 'nothing to preview' using errcode = '22023';
  end if;

  delete from app.import_drafts where created_at < now() - interval '6 hours';

  insert into app.import_drafts
    (company_id, user_id, kind, sheet, branch, existing, city, where_name)
  values
    (p_company, auth.uid(), p_kind, p_sheet,
     nullif(btrim(coalesce(p_branch, '')), ''), p_existing,
     nullif(btrim(coalesce(p_city, '')), ''),
     nullif(btrim(coalesce(p_where_name, '')), ''))
  returning id into v_id;

  return v_id;
end $$;

revoke all on function app.park_import_draft(uuid, text, text, text, uuid, text, text) from public;
grant execute on function app.park_import_draft(uuid, text, text, text, uuid, text, text) to authenticated;

/* -------------------------------------------------------------------------- *
 * Reading one back.
 *
 * SECURITY INVOKER, so the select policy above is what decides whether this
 * person may see this draft. A definer function here would hand any member's
 * draft to anybody holding the id.
 * -------------------------------------------------------------------------- */
create or replace function app.read_import_draft(p_id uuid)
returns table (
  kind text, sheet text, branch text, existing uuid, city text, where_name text
) language sql stable security invoker
set search_path = app, extensions, public, pg_temp as $$
  select d.kind, d.sheet, d.branch, d.existing, d.city, d.where_name
    from app.import_drafts d
   where d.id = p_id;
$$;

revoke all on function app.read_import_draft(uuid) from public;
grant execute on function app.read_import_draft(uuid) to authenticated;

grant select, insert, delete on app.import_drafts to authenticated;

-- PostgREST serves these by name from a cached picture of the schema. Supabase
-- usually refreshes it on its own, but not always: the "Could not find the
-- 'description' column of 'assets' in the schema cache" that followed 0035 was
-- this and nothing else. A new function the app calls by name is the case where
-- a stale cache is guaranteed to bite, so ask for the reload rather than hope.
notify pgrst, 'reload schema';
