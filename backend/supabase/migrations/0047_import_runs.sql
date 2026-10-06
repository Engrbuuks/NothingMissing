-- ============================================================================
-- 0047_import_runs.sql
-- Seeing what each import did, and undoing one.
--
-- 0045 explains why the Import button looked dead: the tag generator made the
-- import quadratic, and a hosted function is killed at ten to fifteen seconds.
-- That account was incomplete in a way that matters.
--
-- What is killed is the request, not the transaction. The gateway stops waiting
-- and the browser gets nothing, but Postgres carries on, finishes the loop and
-- commits. So the import did not write nothing. It wrote everything, said
-- nothing, and left no reason not to press the button again. Press it four
-- times and the register holds four copies, each with its own tags, each
-- looking exactly as legitimate as the first.
--
-- Nothing records which assets an import created, so there is nothing to undo
-- with. Except that there is, and it is exact rather than a guess:
--
--   now() is the transaction timestamp, not the clock. Every asset inserted by
--   one import therefore carries an identical created_at, and the audit row the
--   import writes at the end of the same transaction carries that same value as
--   its occurred_at.
--
-- So an import run is recoverable from the audit log alone, including runs that
-- happened weeks ago, with no new bookkeeping and nothing to backfill. The
-- audit event id is a stable name for a run, and the assets it created are
-- exactly those whose created_at equals its occurred_at.
--
-- Two functions follow. One lists the runs and says which look like repeats of
-- each other. The other removes a run, and refuses to remove anything that has
-- been used since.
-- ============================================================================

-- Finding a run's assets means looking them up by the moment they were made.
create index if not exists assets_company_created_idx
  on app.assets (company_id, created_at);

/* -------------------------------------------------------------------------- *
 * Has anything happened to this asset since it was imported?
 *
 * The question an undo has to answer per asset. The foreign keys already
 * refuse some of this: a transfer line restricts, a disposal restricts. But
 * maintenance, attachments and typed specifications all cascade, which would
 * delete a photograph somebody took or a service record somebody entered
 * without a word about it. So every reference is checked here rather than left
 * to whichever behaviour the column happens to carry.
 *
 * `updated_at > created_at` catches an edit through the form: a corrected
 * name, a serial typed in afterwards, an assignment to somebody.
 * -------------------------------------------------------------------------- */
create or replace function app.asset_is_untouched(p_asset uuid)
returns boolean
language sql stable security definer
set search_path = app, extensions, public, pg_temp as $$
  select exists (select 1 from app.assets a where a.id = p_asset)
     and not exists (select 1 from app.assets a
                      where a.id = p_asset
                        and (a.status <> 'active'
                             or a.updated_at > a.created_at
                             or a.disposed_on is not null
                             or a.serviced_on is not null
                             or a.meter_value <> 0))
     and not exists (select 1 from app.transfer_lines x where x.asset_id = p_asset)
     and not exists (select 1 from app.maintenance_events x where x.asset_id = p_asset)
     and not exists (select 1 from app.disposals x where x.asset_id = p_asset)
     and not exists (select 1 from app.attachments x where x.asset_id = p_asset)
     and not exists (select 1 from app.asset_attributes x where x.asset_id = p_asset)
     and not exists (select 1 from app.discrepancies x where x.asset_id = p_asset)
     and not exists (select 1 from app.requests x where x.asset_id = p_asset)
     and not exists (select 1 from app.submissions x where x.asset_id = p_asset)
     and not exists (select 1 from app.stock_movements x where x.asset_id = p_asset);
$$;

revoke all on function app.asset_is_untouched(uuid) from public;
grant execute on function app.asset_is_untouched(uuid) to authenticated;

/* -------------------------------------------------------------------------- *
 * The runs.
 *
 * SECURITY INVOKER on purpose. Row level security decides which audit rows and
 * which assets this person can see, so somebody scoped to one location sees
 * the imports at that location and the counts for it. A definer function here
 * would quietly widen that.
 *
 * `fingerprint` is what makes a repeat visible: the sorted list of names a run
 * created, hashed. Two runs at one location with the same fingerprint are the
 * same file imported twice. Comparing counts would not do, because a rejected
 * row or an added line changes the count without changing the fact.
 *
 * The "has anything used this" test is done set at a time rather than by
 * calling asset_is_untouched() per row. The per row version is correct and
 * reads better, and it is what the delete uses, where it runs once per asset
 * being removed. Here it would run once per asset ever imported, every time
 * this page loads: 303 ms at nine runs and 4,870 assets, and it grows with the
 * register multiplied by the number of imports. Each reference table is
 * touched once instead.
 * -------------------------------------------------------------------------- */
create or replace function app.asset_import_runs(p_company uuid)
returns table (
  run_id        bigint,
  occurred_at   timestamptz,
  actor         text,
  location      text,
  location_id   uuid,
  reported      int,
  still_present int,
  removable     int,
  in_use        int,
  fingerprint   text,
  repeat_of     bigint
)
language sql stable security invoker
set search_path = app, extensions, public, pg_temp as $$
  with runs as (
    select e.id, e.occurred_at, e.actor_label, e.reference, e.location_id,
           nullif(regexp_replace(coalesce(e.detail, ''), '^(\d+).*$', '\1'), '')::int
             as reported
      from app.audit_events e
     where e.company_id = p_company
       and e.action = 'imported assets'
  ),
  candidates as (
    select a.id, a.created_at, a.name, a.tag,
           (a.status = 'active'
            and a.updated_at = a.created_at
            and a.disposed_on is null
            and a.serviced_on is null
            and a.meter_value = 0) as unedited
      from app.assets a
      join runs r on r.occurred_at = a.created_at
     where a.company_id = p_company
  ),
  -- Every table that can refer to an asset, once each. Kept in step with
  -- asset_is_untouched() by 15_import_undo.sql, which fails if the two
  -- disagree about any one of them.
  used as (
    select asset_id from app.transfer_lines     where asset_id in (select id from candidates)
    union select asset_id from app.maintenance_events where asset_id in (select id from candidates)
    union select asset_id from app.disposals          where asset_id in (select id from candidates)
    union select asset_id from app.attachments        where asset_id in (select id from candidates)
    union select asset_id from app.asset_attributes   where asset_id in (select id from candidates)
    union select asset_id from app.discrepancies      where asset_id in (select id from candidates)
    union select asset_id from app.requests           where asset_id in (select id from candidates)
    union select asset_id from app.submissions        where asset_id in (select id from candidates)
    union select asset_id from app.stock_movements    where asset_id in (select id from candidates)
  ),
  made as (
    select r.id,
           count(c.id)::int as still_present,
           count(c.id) filter (where c.unedited and u.asset_id is null)::int as removable,
           md5(string_agg(c.name, '|' order by c.name, c.tag)) as fingerprint
      from runs r
      left join candidates c on c.created_at = r.occurred_at
      left join used u on u.asset_id = c.id
     group by r.id
  )
  select r.id, r.occurred_at, r.actor_label, r.reference, r.location_id,
         r.reported,
         m.still_present,
         m.removable,
         m.still_present - m.removable,
         m.fingerprint,
         -- The earliest run with the same contents at the same place. Null on
         -- that run itself, so the first import is never offered for removal
         -- as a duplicate of something.
         (select min(e2.id) from runs e2
            join made m2 on m2.id = e2.id
           where m2.fingerprint = m.fingerprint
             and m2.fingerprint is not null
             and e2.reference is not distinct from r.reference
             and e2.id < r.id)
    from runs r
    join made m on m.id = r.id
   order by r.occurred_at desc;
$$;

revoke all on function app.asset_import_runs(uuid) from public;
grant execute on function app.asset_import_runs(uuid) to authenticated;

/* -------------------------------------------------------------------------- *
 * Undoing one run.
 *
 * Owner or admin only. Retiring an asset is a manager's job, because it leaves
 * a record of a thing that existed. This erases rows, which is a different
 * kind of act and belongs with whoever answers for the register.
 *
 * It removes what the run created and nothing else, skips anything in use, and
 * reports both numbers rather than reporting success. Each removal writes its
 * own audit row through the existing trigger, so the register can still account
 * for every tag it ever issued.
 *
 * p_expect is a safety catch. The page shows a count; that count is passed back
 * here; if the register has changed in between, nothing is removed. Without it,
 * a stale page plus a second click is how somebody removes a run they were
 * looking at the numbers for ten minutes ago.
 * -------------------------------------------------------------------------- */
create or replace function app.undo_asset_import(
  p_company uuid,
  p_run_id  bigint,
  p_expect  int default null
) returns jsonb
language plpgsql security definer
set search_path = app, extensions, public, pg_temp as $$
declare
  v_when    timestamptz;
  v_where   text;
  v_loc     uuid;
  v_total   int;
  v_free    int;
  v_removed int;
begin
  if not exists (
    select 1 from app.memberships m
     where m.company_id = p_company and m.user_id = (select auth.uid())
       and m.role in ('owner', 'admin')
  ) then
    raise exception 'only an owner or admin can undo an import' using errcode = '42501';
  end if;

  select e.occurred_at, e.reference, e.location_id
    into v_when, v_where, v_loc
    from app.audit_events e
   where e.id = p_run_id and e.company_id = p_company
     and e.action = 'imported assets';

  if v_when is null then
    raise exception 'that import could not be found' using errcode = 'no_data_found';
  end if;

  select count(*)::int,
         count(*) filter (where app.asset_is_untouched(a.id))::int
    into v_total, v_free
    from app.assets a
   where a.company_id = p_company and a.created_at = v_when;

  if v_total = 0 then
    return jsonb_build_object('removed', 0, 'kept', 0, 'already_undone', true,
      'message', 'Nothing from that import is still on the register.');
  end if;

  -- The register moved under the page this was pressed from.
  if p_expect is not null and p_expect <> v_free then
    raise exception
      'the register has changed since that page was loaded: % can be removed now, not %',
      v_free, p_expect using errcode = '40001';
  end if;

  delete from app.assets a
   where a.company_id = p_company
     and a.created_at = v_when
     and app.asset_is_untouched(a.id);

  get diagnostics v_removed = row_count;

  perform app.log(p_company, 'undid an import', 'assets', p_run_id::text,
    coalesce(v_where, 'an import'),
    format('%s asset(s) removed, %s kept because they are in use', v_removed,
           v_total - v_removed),
    (case when v_total - v_removed > 0 then 'warn' else 'ok' end)::app.audit_tone,
    v_loc);

  return jsonb_build_object(
    'removed', v_removed,
    'kept', v_total - v_removed,
    'location', v_where,
    'already_undone', false);
end $$;

revoke all on function app.undo_asset_import(uuid, bigint, int) from public;
grant execute on function app.undo_asset_import(uuid, bigint, int) to authenticated;

notify pgrst, 'reload schema';
