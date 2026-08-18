-- ============================================================================
-- 0032_repair_status.sql
-- Logging a repair now takes the asset out of service.
--
-- `log_service()` recorded the work and set serviced_on, and left the status
-- alone. So an asset on a workbench in Ibadan still read "In service" on every
-- register, dashboard and report — and `return_to_service()` had nothing to
-- return it from, because nothing had ever taken it away.
--
-- The two functions were written as a pair and only one half did its job. A
-- register that says a broken generator is available is worse than no
-- register, because somebody plans around it.
--
-- Inspections and calibrations deliberately do NOT change the status: checking
-- a machine and finding it fine should not stop anybody using it.
-- ============================================================================

create or replace function app.log_service(
  p_asset  uuid,
  p_kind   text default null,
  p_cost   bigint default null,
  p_vendor text default null,
  p_note   text default null
) returns uuid
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_a    app.assets%rowtype;
  v_id   uuid;
  v_kind text := lower(coalesce(nullif(btrim(p_kind), ''), 'routine'));
  v_out  boolean;
begin
  select * into v_a from app.assets where id = p_asset;
  if not found then
    raise exception 'That asset is not on the register.' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'Your role cannot record maintenance.' using errcode = '42501';
  end if;
  if v_a.status = 'retired' then
    raise exception 'That asset was retired — servicing it would contradict the register.'
      using errcode = 'check_violation',
            hint = 'Bring it back into service first if it is genuinely still in use.';
  end if;
  if v_a.status = 'transit' then
    raise exception 'That asset is in transit and belongs to neither register yet.'
      using errcode = 'check_violation',
            hint = 'Accept the consignment at the destination first, then record the repair.';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say what was wrong or what was done.'
      using errcode = 'check_violation',
            hint = 'Somebody will read this in a year without having been there, and "fixed" tells them nothing.';
  end if;

  insert into app.maintenance_events
    (company_id, asset_id, performed_on, meter_at, kind, cost_minor, vendor, note, logged_by)
  values
    (v_a.company_id, p_asset, current_date, v_a.meter_value, v_kind, p_cost,
     nullif(btrim(coalesce(p_vendor, '')), ''), btrim(p_note), auth.uid())
  returning id into v_id;

  -- Work that takes a machine off the floor. An inspection that found nothing
  -- wrong should not stop anybody using it, so those are left alone.
  v_out := v_kind in ('repair', 'breakdown', 'overhaul');

  update app.assets
     set serviced_on = current_date,
         status = case when v_out then 'repair'::app.asset_status else status end
   where id = p_asset;

  perform app.log(v_a.company_id,
    case when v_out then 'sent something for repair' else 'logged a service' end,
    'assets', p_asset::text, v_a.tag,
    format('%s%s — %s', v_kind,
      case when p_cost is not null then format(' costing NGN %s', p_cost / 100) else '' end,
      btrim(p_note)),
    case when v_out then 'warn'::app.audit_tone else 'info'::app.audit_tone end,
    v_a.location_id);

  return v_id;
end $$;

grant execute on function app.log_service(uuid, text, bigint, text, text) to authenticated;

-- The other half of the pair. Keeping the existing four-argument signature
-- rather than adding a second: `create or replace` cannot change a signature,
-- so a new one would have produced an overload and every caller would then
-- resolve ambiguously. The CI guard exists because I have done that before.
create or replace function app.return_to_service(
  p_asset   uuid,
  p_outcome text,
  p_cost    bigint default null,
  p_note    text default null
) returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_a app.assets%rowtype;
begin
  select * into v_a from app.assets where id = p_asset;
  if not found then
    raise exception 'That asset is not on the register.' using errcode = 'no_data_found';
  end if;
  if not app.can_write(v_a.company_id) then
    raise exception 'Your role cannot return an asset to service.' using errcode = '42501';
  end if;
  if v_a.status <> 'repair' then
    raise exception 'That asset is not out for repair.' using errcode = 'check_violation';
  end if;

  -- Always recorded, cost or none. Coming back from a repair is an event in
  -- the machine's life whether or not anybody was invoiced for it, and a
  -- history with the going-out but not the coming-back reads as though the
  -- thing never returned.
  insert into app.maintenance_events
    (company_id, asset_id, performed_on, meter_at, kind, cost_minor, note, logged_by)
  values (v_a.company_id, p_asset, current_date, v_a.meter_value, 'repair',
          p_cost, concat_ws(' — ', p_outcome, nullif(btrim(coalesce(p_note,'')),'')),
          auth.uid());

  -- A FAILED repair must not put the machine back on the register. It is
  -- still broken; it just cost money to discover that. Returning it would let
  -- somebody plan around a generator sitting dead in a workshop, and it would
  -- let a write-off skip the disposal chain — which is the one action that
  -- always needs two signatures.
  -- Matched on intent rather than an exact list of words. "Could not be
  -- repaired", "beyond economic repair" and "failed" all mean the same thing
  -- to the person typing them, and a literal list would silently return a
  -- dead machine to the register because somebody phrased it differently.
  if lower(coalesce(p_outcome, '')) ~ '(fail|could not|cannot|unrepairable|beyond|scrap|write.?off)' then
    perform app.log(v_a.company_id, 'a repair failed', 'assets', p_asset::text, v_a.tag,
      concat_ws(' — ', p_outcome, nullif(btrim(coalesce(p_note, '')), ''))
        || '. It stays out of service until it is disposed of or repaired again.',
      'bad', v_a.location_id);
    return;
  end if;

  update app.assets set status = 'active', serviced_on = current_date where id = p_asset;

  perform app.log(v_a.company_id, 'returned something to service', 'assets',
    p_asset::text, v_a.tag,
    concat_ws(' — ', p_outcome, nullif(btrim(coalesce(p_note, '')), '')),
    'ok', v_a.location_id);
end $$;

grant execute on function app.return_to_service(uuid, text, bigint, text) to authenticated;

-- The two-argument version I created here by mistake, removed before it can
-- make every call ambiguous.
drop function if exists app.return_to_service(uuid, text);
