-- ============================================================================
-- 0033_delete_person.sql
-- Removing somebody completely.
--
-- Seventeen tables reference app.profiles, every one of them NO ACTION, so a
-- profile could not be deleted at all — the database simply refused. There was
-- `remove_member()`, which took away access and left the account in place, and
-- nothing that actually removed a person.
--
-- ── What gets deleted ─────────────────────────────────────────────────────
--   their profile, their memberships, their view preferences, their
--   delegations, their consents, invitations they hold, and their login
--
-- ── What survives, and why ────────────────────────────────────────────────
--   Every record of something they DID. An approval they gave, a transfer they
--   dispatched, a count they reviewed, an audit row with their name on it.
--
--   Those belong to the company, not to the person. A transfer approved by
--   somebody who has since left must keep saying so — otherwise deleting a
--   user becomes a way to erase the evidence of what they authorised, and
--   deleting the person who signed off a disposal would quietly unsign it.
--
--   The audit log keeps `actor_label`, which is TEXT, so it still reads
--   "Adeola Bello dispatched WB-2026-0001". Only the pointer to a live account
--   is released. The history stays readable; the account is gone.
--
-- Owner only. An admin removing an admin, or an admin removing the person who
-- can remove them, is how a company loses control of itself.
-- ============================================================================

-- Release the pointer rather than block the delete. Every one of these tables
-- also stores a text label captured at the time, so nothing becomes anonymous
-- — it stops resolving to an account, which is exactly what has happened.
do $$
declare r record;
begin
  for r in
    select tc.constraint_name, tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name = tc.constraint_name
    join information_schema.referential_constraints rc
      on rc.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'app'
      and ccu.table_name = 'profiles'
      and rc.delete_rule = 'NO ACTION'
  loop
    execute format('alter table app.%I drop constraint %I', r.table_name, r.constraint_name);
    execute format(
      'alter table app.%I add constraint %I foreign key (%I) references app.profiles(id) on delete set null',
      r.table_name, r.constraint_name, r.column_name);
  end loop;
end $$;

-- The audit log refuses UPDATE, and a SET NULL cascade IS an update, so the
-- delete would fail on the log alone. The trigger already permits releasing
-- location_id for the same reason (0015); actor_id needs the same narrow
-- exception, and nothing wider.
create or replace function app.audit_is_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    -- A deleted location releasing its reference.
    if new.location_id is null and old.location_id is not null
       and to_jsonb(new) - 'location_id' = to_jsonb(old) - 'location_id'
    then
      return new;
    end if;

    -- A deleted person releasing theirs. actor_label is untouched, so the row
    -- still says who did it — it simply no longer points at a live account.
    if new.actor_id is null and old.actor_id is not null
       and to_jsonb(new) - 'actor_id' = to_jsonb(old) - 'actor_id'
    then
      return new;
    end if;
  end if;

  raise exception 'the audit log is append-only: % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Correct a mistake by writing a further event, not by editing history.';
end $$;

-- ============================================================================
create or replace function app.delete_person(p_company uuid, p_user uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_name    text;
  v_email   text;
  v_owners  int;
  v_other   int;
  v_actions int;
begin
  if not app.has_role(p_company, 'owner') then
    raise exception 'Only an owner can delete somebody.'
      using errcode = '42501',
            hint = 'An admin can remove access, which is reversible. Deleting an account is not.';
  end if;

  if p_user = auth.uid() then
    raise exception 'You cannot delete yourself.'
      using errcode = 'check_violation',
            hint = 'Ask another owner, so the company is never left without one.';
  end if;

  select coalesce(full_name, email::text), email::text into v_name, v_email
    from app.profiles where id = p_user;

  if v_name is null then
    raise exception 'No such person.' using errcode = 'no_data_found';
  end if;

  -- Typing the name is the confirmation. A dialogue somebody clicks through is
  -- not a confirmation, and this is not undoable.
  if lower(btrim(coalesce(p_confirm, ''))) not in (lower(v_name), lower(coalesce(v_email, ''))) then
    raise exception 'Type their name or email exactly to confirm.'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from app.memberships
             where company_id = p_company and user_id = p_user and role = 'owner') then
    select count(*) into v_owners from app.memberships
     where company_id = p_company and role = 'owner' and user_id <> p_user;
    if v_owners = 0 then
      raise exception 'That is the last owner — the company would be left unadministrable.'
        using errcode = 'check_violation',
              hint = 'Make somebody else an owner first.';
    end if;
  end if;

  select count(*) into v_actions from app.audit_events where actor_id = p_user;

  -- Anything scoped to a person and meaningless without them.
  delete from app.delegations
   where company_id = p_company and (from_user = p_user or to_user = p_user);
  delete from app.view_preferences where user_id = p_user and company_id = p_company;
  delete from app.invitations
   where company_id = p_company and lower(email::text) = lower(coalesce(v_email, ''))
     and accepted_at is null;
  delete from app.memberships where company_id = p_company and user_id = p_user;

  -- Their account itself goes only if they belong to nobody else. Somebody who
  -- works for two companies on this platform must not lose their login because
  -- one of them removed them.
  select count(*) into v_other from app.memberships where user_id = p_user;

  if v_other = 0 then
    -- The cascades above release every reference; the records themselves stay,
    -- carrying the name they captured at the time.
    delete from app.consents where user_id = p_user;
    delete from app.view_preferences where user_id = p_user;
    delete from app.profiles where id = p_user;
  end if;

  perform app.log(p_company, 'deleted a person', 'profiles', p_user::text, v_name,
    format('%s. %s',
      case when v_other = 0
           then 'Their account was removed entirely'
           else format('Removed from this company; they still belong to %s other', v_other) end,
      case when v_actions = 0
           then 'They had done nothing on the register'
           else format('%s recorded action(s) keep their name — that history belongs to the company', v_actions) end),
    'bad');

  return jsonb_build_object(
    'deleted', true,
    'name', v_name,
    'account_removed', v_other = 0,
    'actions_retained', v_actions);
end $$;

grant execute on function app.delete_person(uuid, uuid, text) to authenticated;

-- Deleting an invitation outright, for somebody who was invited by mistake and
-- never accepted. Revoking leaves a record that they were asked; this removes
-- it, which is right when the address itself was the mistake.
create or replace function app.delete_invitation(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.invitations%rowtype;
begin
  select * into v_i from app.invitations where id = p_id;
  if not found then
    raise exception 'No such invitation.' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_i.company_id, 'owner') then
    raise exception 'Only an owner can delete an invitation outright.'
      using errcode = '42501',
            hint = 'An admin can withdraw it, which leaves a record that it was sent.';
  end if;
  if v_i.accepted_at is not null then
    raise exception 'That invitation was accepted — the person is a member now.'
      using errcode = 'check_violation',
            hint = 'Remove them from the company instead.';
  end if;

  delete from app.invitations where id = p_id;

  perform app.log(v_i.company_id, 'deleted an invitation', 'invitations', p_id::text,
    v_i.email::text, 'Removed entirely rather than withdrawn', 'warn');

  return jsonb_build_object('deleted', true, 'email', v_i.email);
end $$;

grant execute on function app.delete_invitation(uuid) to authenticated;

-- What deleting somebody would actually do, shown before it is done. Nobody
-- should discover what a destructive action keeps by performing it.
create or replace function app.deletion_preview(p_company uuid, p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_name text; v_other int; v_actions int; v_approvals int; v_reviews int;
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select coalesce(full_name, email::text) into v_name from app.profiles where id = p_user;
  if v_name is null then
    return jsonb_build_object('found', false);
  end if;

  select count(*) into v_other from app.memberships
   where user_id = p_user and company_id <> p_company;
  select count(*) into v_actions from app.audit_events
   where company_id = p_company and actor_id = p_user;
  select count(*) into v_approvals from app.request_steps where decided_by = p_user;
  select count(*) into v_reviews from app.submissions where reviewed_by = p_user;

  return jsonb_build_object(
    'found', true,
    'name', v_name,
    'account_would_go', v_other = 0,
    'other_companies', v_other,
    'recorded_actions', v_actions,
    'approvals_given', v_approvals,
    'submissions_reviewed', v_reviews);
end $$;

grant execute on function app.deletion_preview(uuid, uuid) to authenticated;
