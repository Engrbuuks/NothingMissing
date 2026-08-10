-- ============================================================================
-- 0015_deletion.sql
-- Deleting things — and being honest about what cannot be deleted.
--
-- The distinction that matters is not "important" versus "unimportant". It is
-- whether anything else in the system points at the row.
--
--   * A location created by mistake five minutes ago, with no assets, no
--     waybills and no audit rows beyond its own creation, is a typo. Deleting
--     it loses nothing and leaving it clutters every picker forever.
--
--   * A location that has ever appeared on a waybill is referenced by that
--     waybill, by every asset that passed through it, and by audit rows
--     describing movements. Deleting it turns each of those into a dangling
--     pointer — the waybill still prints, but the "From" is now blank, and
--     nobody can tell whether that is a bug or a cover-up. That one archives.
--
-- So every delete_* function below checks what refers to the row and either
-- removes it cleanly or refuses with a specific reason and a way forward. It
-- never cascades silently, and it never leaves a half-deleted graph.
--
-- Two things are never deletable, by anyone, including an owner:
--   * audit_events — the log is the product. See 0003.
--   * stock_movements — a balance you cannot explain is not a balance.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The audit log refuses UPDATE as firmly as DELETE, so a location cannot be
-- deleted while its own creation row points at it — and that row can never be
-- edited to release the pointer.
--
-- The right fix is at the foreign key, not the log: ON DELETE SET NULL. The
-- event survives untouched, saying a location was created; it simply no longer
-- resolves to a live location, because there is not one. Nothing is erased and
-- nothing is rewritten. The alternative — letting application code edit audit
-- rows — would put a hole in the one guarantee the product rests on.
-- ---------------------------------------------------------------------------
alter table app.audit_events
  drop constraint if exists audit_events_location_id_fkey;
alter table app.audit_events
  add constraint audit_events_location_id_fkey
  foreign key (location_id) references app.locations(id) on delete set null;

-- The cascade above is itself an UPDATE, so the immutability trigger blocks it
-- and the delete fails. The trigger has to tell a referential cascade apart
-- from someone editing the record.
--
-- It is allowed to release exactly one pointer — location_id, to null — and
-- nothing else. Every other column, and any change to location_id that is not
-- a release, still raises. That keeps the guarantee precise rather than
-- opening a general-purpose hole in it.
create or replace function app.audit_is_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and new.location_id is null
     and old.location_id is not null
     -- everything else must be untouched
     and to_jsonb(new) - 'location_id' = to_jsonb(old) - 'location_id'
  then
    return new;   -- a deleted location releasing its reference
  end if;

  raise exception 'the audit log is append-only: % is not permitted', tg_op
    using errcode = '42501',
          hint = 'Correct a mistake by writing a further event, not by editing history.';
end $$;

-- One more consequence: the generic change tracker logs a DELETE on locations
-- and tries to file that event *at* the location just removed, which the
-- foreign key rejects. A deletion event cannot be filed at the thing it
-- deleted. Stop passing the location for that one case; the name is already in
-- the reference column, so nothing is lost.
create or replace function app.audit_row_change()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid; v_ref text; v_loc uuid;
  v_before jsonb; v_after jsonb; v_action text; v_row jsonb;
begin
  v_row := to_jsonb(coalesce(new, old));
  v_company := (v_row ->> 'company_id')::uuid;
  if v_company is null then return coalesce(new, old); end if;

  if tg_nargs > 0 and tg_argv[0] is not null and tg_argv[0] <> '' then
    v_ref := v_row ->> tg_argv[0];
  end if;
  if tg_nargs > 1 and tg_argv[1] is not null and tg_argv[1] <> '' then
    v_loc := nullif(v_row ->> tg_argv[1], '')::uuid;
  end if;

  -- A row cannot be filed at a location that is being deleted in this very
  -- statement, so drop the reference for that case only.
  if tg_op = 'DELETE' and tg_table_name = 'locations' then
    v_loc := null;
  end if;

  if tg_op = 'INSERT' then
    v_action := 'created ' || tg_table_name; v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_action := 'updated ' || tg_table_name;
    v_before := to_jsonb(old); v_after := to_jsonb(new);
    if v_before = v_after then return new; end if;
  else
    v_action := 'deleted ' || tg_table_name; v_before := to_jsonb(old);
  end if;

  perform app.log(
    v_company, v_action, tg_table_name, (v_row ->> 'id'), v_ref, null,
    case tg_op when 'DELETE' then 'warn'::app.audit_tone else 'info'::app.audit_tone end,
    v_loc, v_before, v_after);

  return coalesce(new, old);
end $$;

-- Small helper so every refusal reads the same way.
create or replace function app.refuse(p_what text, p_because text, p_instead text)
returns void language plpgsql as $$
begin
  raise exception '% %', p_what, p_because
    using errcode = 'check_violation', hint = p_instead;
end $$;

-- ------------------------------------------------------------ locations ----
create or replace function app.delete_location(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_l app.locations%rowtype; v_n int;
begin
  select * into v_l from app.locations where id = p_id for update;
  if not found then
    raise exception 'That location no longer exists.' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_l.company_id, 'owner', 'admin') then
    raise exception 'Only an owner or admin can remove a location.' using errcode = '42501';
  end if;
  if v_l.kind = 'virtual' then
    perform app.refuse('The virtual warehouse cannot be removed.',
      'It is where swept, retired and unassigned assets live.',
      'Every company keeps exactly one.');
  end if;

  -- Anything currently there.
  select count(*) into v_n from app.assets where location_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('This location still holds %s asset(s).', v_n), '',
      'Sweep them to the virtual warehouse first, then remove it.');
  end if;

  select count(*) into v_n from app.stock_balances where location_id = p_id and qty <> 0;
  if v_n > 0 then
    perform app.refuse(format('This location still holds stock on %s line(s).', v_n), '',
      'Move the stock elsewhere first.');
  end if;

  -- Anything that has ever happened here. This is the test that separates a
  -- typo from a site with a history.
  select count(*) into v_n from app.transfers
   where from_location = p_id or to_location = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s consignment(s) reference this location.', v_n),
      'Deleting it would leave those waybills pointing at nothing.',
      'Archive it instead — it disappears from pickers but still reads correctly in history.');
  end if;

  select count(*) into v_n from app.stock_movements where location_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s stock movement(s) happened here.', v_n),
      'The ledger would stop explaining itself.',
      'Archive it instead.');
  end if;

  select count(*) into v_n from app.submissions where location_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s field submission(s) came from here.', v_n), '',
      'Archive it instead.');
  end if;

  -- Only the location's own creation row should remain. More than that means
  -- something happened here worth keeping.
  select count(*) into v_n from app.audit_events
   where location_id = p_id and entity <> 'locations';
  if v_n > 0 then
    perform app.refuse(format('%s recorded event(s) happened at this location.', v_n),
      'They would lose the place they refer to.',
      'Archive it instead — nothing is lost and it stops appearing in pickers.');
  end if;

  -- Clean: memberships and links scoped here go with it, since they mean
  -- nothing without it.
  delete from app.memberships where location_id = p_id;
  delete from app.location_links where location_id = p_id;
  delete from app.link_holders where location_id = p_id;

  -- Audit rows pointing here have their location reference set to null by the
  -- foreign key, not by us. The rows themselves are untouched.
  delete from app.locations where id = p_id;

  -- Note: no location passed. The row cannot point at what it just removed.
  perform app.log(v_l.company_id, 'deleted a location', 'locations', p_id::text, v_l.name,
    'It had no history — nothing referenced it', 'warn');

  return jsonb_build_object('deleted', true, 'name', v_l.name);
end $$;

-- ------------------------------------------------------------- catalog -----
create or replace function app.delete_model(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_m app.models%rowtype; v_n int;
begin
  select * into v_m from app.models where id = p_id;
  if not found then raise exception 'That model no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_m.company_id, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select count(*) into v_n from app.assets where model_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s asset(s) are this model.', v_n),
      'They would lose their specification, service interval and warranty term.',
      'Move them to another model first, or leave this one in place — an unused model costs nothing.');
  end if;

  select count(*) into v_n from app.purchase_order_lines where model_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s purchase order line(s) order this model.', v_n), '',
      'Leave it in place so those orders still describe what was bought.');
  end if;

  delete from app.models where id = p_id;
  perform app.log(v_m.company_id, 'deleted a catalog model', 'models', p_id::text, v_m.name,
    'Nothing was using it', 'warn');
  return jsonb_build_object('deleted', true, 'name', v_m.name);
end $$;

create or replace function app.delete_brand(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_b app.brands%rowtype; v_n int;
begin
  select * into v_b from app.brands where id = p_id;
  if not found then raise exception 'That brand no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_b.company_id, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  select count(*) into v_n from app.models where brand_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s model(s) belong to this brand.', v_n), '',
      'Remove or reassign those models first.');
  end if;
  delete from app.brands where id = p_id;
  perform app.log(v_b.company_id, 'deleted a brand', 'brands', p_id::text, v_b.name, null, 'warn');
  return jsonb_build_object('deleted', true, 'name', v_b.name);
end $$;

create or replace function app.delete_sub_category(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_s app.sub_categories%rowtype; v_n int;
begin
  select * into v_s from app.sub_categories where id = p_id;
  if not found then raise exception 'That type no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_s.company_id, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  select count(*) into v_n from app.models where sub_category_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s model(s) sit under this type.', v_n), '',
      'Remove or move those models first.');
  end if;
  delete from app.sub_categories where id = p_id;
  perform app.log(v_s.company_id, 'deleted a catalog type', 'sub_categories', p_id::text, v_s.name, null, 'warn');
  return jsonb_build_object('deleted', true, 'name', v_s.name);
end $$;

create or replace function app.delete_category(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_c app.categories%rowtype; v_n int;
begin
  select * into v_c from app.categories where id = p_id;
  if not found then raise exception 'That category no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_c.company_id, 'owner','admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  select count(*) into v_n from app.sub_categories where category_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s type(s) sit under this category.', v_n), '',
      'Remove those first.');
  end if;
  delete from app.categories where id = p_id;
  perform app.log(v_c.company_id, 'deleted a category', 'categories', p_id::text, v_c.name, null, 'warn');
  return jsonb_build_object('deleted', true, 'name', v_c.name);
end $$;

-- --------------------------------------------------------- stock items -----
create or replace function app.delete_stock_item(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.stock_items%rowtype; v_n int;
begin
  select * into v_i from app.stock_items where id = p_id;
  if not found then raise exception 'That item no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_i.company_id, 'owner','admin') then
    raise exception 'Only an owner or admin can remove a stock item.' using errcode = '42501';
  end if;

  select count(*) into v_n from app.stock_movements where item_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('This item has %s ledger movement(s).', v_n),
      'Deleting it would leave receipts and issues describing nothing.',
      'Archive it instead — it stops appearing on count sheets but its history survives.');
  end if;

  delete from app.stock_balances where item_id = p_id;
  delete from app.stock_items where id = p_id;
  perform app.log(v_i.company_id, 'deleted a stock item', 'stock_items', p_id::text, v_i.sku,
    'It had never moved', 'warn');
  return jsonb_build_object('deleted', true, 'name', v_i.name);
end $$;

create or replace function app.archive_stock_item(p_id uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_i app.stock_items%rowtype;
begin
  select * into v_i from app.stock_items where id = p_id;
  if not found then return; end if;
  if not app.has_role(v_i.company_id, 'owner','admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update app.stock_items set archived_at = now() where id = p_id;
  perform app.log(v_i.company_id, 'archived a stock item', 'stock_items', p_id::text, v_i.sku,
    'Hidden from count sheets; its ledger history is untouched', 'warn');
end $$;

-- ---------------------------------------------------------- transfers ------
-- Only a draft. Once a waybill exists the consignment is a document, and
-- documents are cancelled rather than deleted.
create or replace function app.delete_transfer(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_t app.transfers%rowtype;
begin
  select * into v_t from app.transfers where id = p_id for update;
  if not found then raise exception 'That transfer no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_t.company_id, 'owner','admin','manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_t.status <> 'draft' then
    perform app.refuse(format('This consignment is %s, not a draft.', v_t.status),
      'Once it has been approved or dispatched it is a document.',
      'Cancel it instead — it stays in the record with its reason.');
  end if;

  delete from app.transfer_lines where transfer_id = p_id;
  delete from app.transfers where id = p_id;
  perform app.log(v_t.company_id, 'deleted a draft transfer', 'transfers', p_id::text,
    v_t.reference, 'It was never approved or dispatched', 'warn');
  return jsonb_build_object('deleted', true, 'reference', v_t.reference);
end $$;

-- ---------------------------------------------------------- suppliers ------
create or replace function app.delete_supplier(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_s app.suppliers%rowtype; v_n int;
begin
  select * into v_s from app.suppliers where id = p_id;
  if not found then raise exception 'That supplier no longer exists.' using errcode='no_data_found'; end if;
  if not app.has_role(v_s.company_id, 'owner','admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  select count(*) into v_n from app.purchase_orders where supplier_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s purchase order(s) name this supplier.', v_n),
      'Those orders would stop saying who supplied the goods.',
      'Archive them instead — they disappear from pickers and keep their history.');
  end if;
  delete from app.suppliers where id = p_id;
  perform app.log(v_s.company_id, 'deleted a supplier', 'suppliers', p_id::text, v_s.name, null, 'warn');
  return jsonb_build_object('deleted', true, 'name', v_s.name);
end $$;

create or replace function app.archive_supplier(p_id uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_s app.suppliers%rowtype;
begin
  select * into v_s from app.suppliers where id = p_id;
  if not found then return; end if;
  if not app.has_role(v_s.company_id, 'owner','admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  update app.suppliers set archived_at = now() where id = p_id;
  perform app.log(v_s.company_id, 'archived a supplier', 'suppliers', p_id::text, v_s.name, null, 'warn');
end $$;

-- ------------------------------------------------------------- people ------
create or replace function app.remove_member(p_company uuid, p_user uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_owners int; v_name text; v_role app.role_type;
begin
  if not app.has_role(p_company, 'owner','admin') then
    raise exception 'Only an owner or admin can remove someone.' using errcode = '42501';
  end if;
  if p_user = auth.uid() then
    perform app.refuse('You cannot remove yourself.', '',
      'Ask another owner or admin to do it, so the company is never left without one.');
  end if;

  select min(role) into v_role from app.memberships
   where company_id = p_company and user_id = p_user;
  if v_role is null then
    raise exception 'That person is not a member of this company.' using errcode = 'no_data_found';
  end if;

  -- An admin cannot remove an owner. Otherwise the hierarchy is decorative.
  if v_role = 'owner' and app.role_in(p_company) <> 'owner' then
    raise exception 'Only an owner can remove another owner.' using errcode = '42501';
  end if;

  select count(*) into v_owners from app.memberships
   where company_id = p_company and role = 'owner' and user_id <> p_user;
  if v_role = 'owner' and v_owners = 0 then
    perform app.refuse('This is the last owner.', 'A company without an owner is unreachable.',
      'Make somebody else an owner first.');
  end if;

  select coalesce(full_name, email::text) into v_name from app.profiles where id = p_user;

  -- The person's memberships go. Their name stays on every audit row, every
  -- approval and every waybill they touched — that history is not theirs to
  -- take with them.
  delete from app.memberships where company_id = p_company and user_id = p_user;
  delete from app.delegations where company_id = p_company
     and (from_user = p_user or to_user = p_user);

  perform app.log(p_company, 'removed someone from the company', 'memberships',
    p_user::text, v_name, 'Their access is gone; their history remains', 'warn');

  return jsonb_build_object('removed', true, 'name', v_name);
end $$;

create or replace function app.delete_link_holder(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_h app.link_holders%rowtype; v_n int;
begin
  select * into v_h from app.link_holders where id = p_id;
  if not found then raise exception 'That person is not on record.' using errcode='no_data_found'; end if;
  if not app.has_role(v_h.company_id, 'owner','admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  select count(*) into v_n from app.submissions where holder_id = p_id;
  if v_n > 0 then
    perform app.refuse(format('%s submission(s) came from this person.', v_n),
      'Their counts would stop having a name against them.',
      'Revoke their links instead — they can no longer submit, and their record stands.');
  end if;
  delete from app.location_links where holder_id = p_id;
  delete from app.link_holders where id = p_id;
  perform app.log(v_h.company_id, 'removed a link holder', 'link_holders', p_id::text, v_h.name,
    'They had never submitted anything', 'warn');
  return jsonb_build_object('deleted', true, 'name', v_h.name);
end $$;

-- ------------------------------------------------- the company itself ------
-- Deliberately not a delete. A company holds other people's memberships, their
-- submissions and an audit trail they may need after a dispute, so it archives
-- and the slug is retired with it — nobody else can claim an address whose
-- links are still circulating on people's phones.
create or replace function app.archive_company(p_company uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_c app.companies%rowtype;
begin
  select * into v_c from app.companies where id = p_company for update;
  if not found then raise exception 'No such company.' using errcode = 'no_data_found'; end if;
  if not app.has_role(p_company, 'owner') then
    raise exception 'Only an owner can close a company.' using errcode = '42501';
  end if;
  if lower(btrim(coalesce(p_confirm,''))) <> lower(v_c.name) then
    raise exception 'Type the company name exactly to confirm.' using errcode = 'check_violation';
  end if;

  update app.companies set archived_at = now() where id = p_company;
  update app.location_links set revoked_at = now()
   where company_id = p_company and revoked_at is null;

  perform app.log(p_company, 'closed the company', 'companies', p_company::text, v_c.name,
    'Archived. Every field link is revoked and the address is retired.', 'bad');

  return jsonb_build_object('archived', true, 'name', v_c.name);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'delete_location(uuid)','delete_model(uuid)','delete_brand(uuid)',
    'delete_sub_category(uuid)','delete_category(uuid)','delete_stock_item(uuid)',
    'archive_stock_item(uuid)','delete_transfer(uuid)','delete_supplier(uuid)',
    'archive_supplier(uuid)','remove_member(uuid,uuid)','delete_link_holder(uuid)',
    'archive_company(uuid,text)'
  ] loop
    execute format('grant execute on function app.%s to authenticated', f);
  end loop;
end $$;
