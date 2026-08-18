-- ============================================================================
-- 0031_orders_and_approvals.sql
-- Two things that were modelled but had no way in.
--
-- 1. PURCHASE ORDERS COULD NOT BE CREATED. The table, the lines, the statuses
--    and receive_goods() all existed since 0009 — and there was no function to
--    raise one and no page to do it from. The screen listed purchase orders
--    that could never come into being.
--
-- 2. THE APPROVAL HIERARCHY COULD ONLY BE SET IN SQL. approval_policies is the
--    heart of the product: it is what decides that a ₦2m purchase needs two
--    signatures and a ₦40k one needs one. A company could not configure it
--    without somebody writing an insert by hand, which means every company was
--    running on whatever the seed happened to contain — or on nothing.
--
-- I flagged the second one as a gap early and did not build it, which made the
-- approval chain a feature in the documentation rather than in the product.
-- ============================================================================

-- =========================================================== purchase orders =
create or replace function app.raise_purchase_order(
  p_supplier    uuid,
  p_destination uuid,
  p_lines       jsonb,       -- [{model_id?, description, qty, unit_cost}]
  p_expected_on date default null,
  p_notes       text default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare
  v_company uuid;
  v_ref     text;
  v_id      uuid;
  v_line    jsonb;
  v_total   bigint := 0;
  v_qty     numeric;
  v_cost    bigint;
  v_count   int := 0;
begin
  select company_id into v_company from app.locations where id = p_destination;
  if v_company is null then
    raise exception 'That destination is not a location.' using errcode = 'foreign_key_violation';
  end if;

  if not app.has_role(v_company, 'owner', 'admin', 'manager') then
    raise exception 'Your role cannot raise a purchase order.'
      using errcode = '42501',
            hint = 'A requester can raise a request for something to be bought; turning that into an order is a manager''s job.';
  end if;

  if p_supplier is not null and not exists (
    select 1 from app.suppliers where id = p_supplier and company_id = v_company
  ) then
    raise exception 'That supplier is not on your list.' using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'An order needs at least one line.' using errcode = 'check_violation';
  end if;

  v_ref := app.next_doc_number(v_company, 'po');

  insert into app.purchase_orders
    (company_id, reference, supplier_id, destination, status, expected_on, raised_by, notes)
  values
    (v_company, v_ref, p_supplier, p_destination, 'draft', p_expected_on, auth.uid(),
     nullif(btrim(coalesce(p_notes, '')), ''))
  returning id into v_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty  := coalesce((v_line ->> 'qty')::numeric, 0);
    v_cost := coalesce((regexp_replace(coalesce(v_line ->> 'unit_cost',''), '[^0-9]', '', 'g'))::bigint, 0) * 100;

    continue when v_qty <= 0;

    v_count := v_count + 1;

    insert into app.purchase_order_lines
      (po_id, company_id, line_no, kind, model_id, stock_item_id,
       description, qty, unit_cost_minor)
    values
      (v_id, v_company, v_count,
       -- An ordered thing is one of three, and the schema is right to insist:
       -- an ASSET line must name a catalog model, because receiving it creates
       -- a tagged unit that inherits a specification. A STOCK line must name
       -- an item, because receiving it moves a balance. Anything else is a
       -- SERVICE — labour, transport, a callout — which arrives as neither.
       --
       -- Defaulting an unqualified line to 'asset' would have created assets
       -- with no model, which is the exact thing the catalog exists to prevent.
       (case
          when nullif(v_line ->> 'model_id','') is not null then 'asset'
          when nullif(v_line ->> 'stock_item_id','') is not null then 'stock'
          else 'service'
        end)::app.po_line_kind,
       nullif(v_line ->> 'model_id', '')::uuid,
       nullif(v_line ->> 'stock_item_id', '')::uuid,
       coalesce(nullif(btrim(coalesce(v_line ->> 'description','')), ''), 'Unnamed line'),
       v_qty, v_cost);

    v_total := v_total + (v_qty * v_cost)::bigint;
  end loop;

  if v_count = 0 then
    raise exception 'Every line had a quantity of zero.' using errcode = 'check_violation';
  end if;

  perform app.log(v_company, 'raised a purchase order', 'purchase_orders', v_id::text, v_ref,
    format('%s line(s), %s', v_count,
      case when v_total > 0 then 'NGN ' || (v_total / 100)::text else 'no cost recorded' end),
    'info', p_destination);

  return jsonb_build_object(
    'purchase_order_id', v_id, 'reference', v_ref,
    'lines', v_count, 'total_minor', v_total);
end $$;

grant execute on function app.raise_purchase_order(uuid, uuid, jsonb, date, text) to authenticated;

-- Issuing sends it to the supplier. Separate from raising, because a draft is
-- somebody thinking and an issued order is a commitment.
create or replace function app.issue_purchase_order(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_po app.purchase_orders%rowtype; v_total bigint;
begin
  select * into v_po from app.purchase_orders where id = p_id for update;
  if not found then
    raise exception 'No such order.' using errcode = 'no_data_found';
  end if;
  if not app.has_role(v_po.company_id, 'owner', 'admin', 'manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_po.status <> 'draft' then
    raise exception 'This order is already %.', v_po.status using errcode = 'check_violation';
  end if;

  select coalesce(sum(qty * unit_cost_minor), 0)::bigint into v_total
    from app.purchase_order_lines where po_id = p_id;

  update app.purchase_orders
     set status = 'issued', issued_at = now()
   where id = p_id;

  perform app.log(v_po.company_id, 'issued a purchase order', 'purchase_orders',
    p_id::text, v_po.reference,
    format('sent to %s', coalesce(
      (select name from app.suppliers where id = v_po.supplier_id), 'no supplier named')),
    'ok', v_po.destination);

  return jsonb_build_object('ok', true, 'reference', v_po.reference, 'total_minor', v_total);
end $$;

grant execute on function app.issue_purchase_order(uuid) to authenticated;

create or replace function app.cancel_purchase_order(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_po app.purchase_orders%rowtype;
begin
  select * into v_po from app.purchase_orders where id = p_id for update;
  if not found then return; end if;
  if not app.has_role(v_po.company_id, 'owner', 'admin', 'manager') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_po.status = 'received' then
    raise exception 'That order was already received — cancelling it would contradict the register.'
      using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Say why it was cancelled.' using errcode = 'check_violation',
      hint = 'In six months somebody will ask, and "cancelled" on its own answers nothing.';
  end if;

  update app.purchase_orders set status = 'cancelled' where id = p_id;
  perform app.log(v_po.company_id, 'cancelled a purchase order', 'purchase_orders',
    p_id::text, v_po.reference, btrim(p_reason), 'warn', v_po.destination);
end $$;

grant execute on function app.cancel_purchase_order(uuid, text) to authenticated;

-- ======================================================= approval hierarchy ==
-- The chain is an array of roles in order: array['manager','admin'] means a
-- manager signs, then an admin. role_satisfies() already lets seniority cover
-- a junior step, so an owner can sign a manager's slot.
create or replace function app.set_approval_policy(
  p_company    uuid,
  p_type       app.request_type,
  p_name       text,
  p_chain      text[],
  p_min_amount bigint default null,
  p_max_amount bigint default null,
  p_min_items  int default null,
  p_max_items  int default null,
  p_priority   int default 100,
  p_id         uuid default null
) returns jsonb
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_id uuid; v_chain app.role_type[];
begin
  if not app.has_role(p_company, 'owner', 'admin') then
    raise exception 'Only an owner or admin can change who approves what.'
      using errcode = '42501';
  end if;

  if array_length(p_chain, 1) is null or array_length(p_chain, 1) = 0 then
    raise exception 'A policy needs at least one approver.'
      using errcode = 'check_violation',
            hint = 'If nothing needs approving, delete the policy rather than emptying it — an empty chain would let anything through silently.';
  end if;

  if array_length(p_chain, 1) > 4 then
    raise exception 'Four signatures is the most a chain can ask for.'
      using errcode = 'check_violation',
            hint = 'Beyond that people stop reading and start clicking, which is worse than one approver who actually looks.';
  end if;

  v_chain := p_chain::app.role_type[];

  -- An auditor cannot approve, because an auditor cannot write. A chain naming
  -- one would stall forever with nobody able to clear it.
  if 'auditor' = any(v_chain) then
    raise exception 'An auditor reads and never writes, so cannot be an approver.'
      using errcode = 'check_violation';
  end if;

  if p_min_amount is not null and p_max_amount is not null
     and p_min_amount > p_max_amount then
    raise exception 'The lower bound is above the upper one.' using errcode = 'check_violation';
  end if;

  if p_id is null then
    insert into app.approval_policies
      (company_id, request_type, name, chain, min_amount_minor, max_amount_minor,
       min_items, max_items, priority)
    values
      (p_company, p_type, btrim(p_name), v_chain, p_min_amount, p_max_amount,
       p_min_items, p_max_items, p_priority)
    returning id into v_id;

    perform app.log(p_company, 'added an approval rule', 'approval_policies', v_id::text,
      btrim(p_name), format('%s: %s', p_type, array_to_string(p_chain, ' then ')), 'warn');
  else
    update app.approval_policies
       set request_type = p_type, name = btrim(p_name), chain = v_chain,
           min_amount_minor = p_min_amount, max_amount_minor = p_max_amount,
           min_items = p_min_items, max_items = p_max_items, priority = p_priority
     where id = p_id and company_id = p_company
    returning id into v_id;

    if v_id is null then
      raise exception 'No such rule.' using errcode = 'no_data_found';
    end if;

    perform app.log(p_company, 'changed an approval rule', 'approval_policies', v_id::text,
      btrim(p_name), format('%s: %s', p_type, array_to_string(p_chain, ' then ')), 'warn');
  end if;

  return jsonb_build_object('id', v_id);
end $$;

grant execute on function app.set_approval_policy(uuid, app.request_type, text, text[], bigint, bigint, int, int, int, uuid) to authenticated;

create or replace function app.delete_approval_policy(p_id uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
declare v_p app.approval_policies%rowtype; v_left int;
begin
  select * into v_p from app.approval_policies where id = p_id;
  if not found then return; end if;
  if not app.has_role(v_p.company_id, 'owner', 'admin') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select count(*) into v_left from app.approval_policies
   where company_id = v_p.company_id and request_type = v_p.request_type
     and id <> p_id and active;

  if v_left = 0 then
    raise exception 'This is the last rule for %, and removing it would let anything through unapproved.', v_p.request_type
      using errcode = 'check_violation',
            hint = 'Add a replacement first, even a permissive one — a request type with no rule is a request type nobody signs for.';
  end if;

  delete from app.approval_policies where id = p_id;
  perform app.log(v_p.company_id, 'removed an approval rule', 'approval_policies',
    p_id::text, v_p.name, null, 'warn');
end $$;

grant execute on function app.delete_approval_policy(uuid) to authenticated;

-- What a company's rules actually are, in words, so the page can show them
-- without anybody reading array syntax.
create or replace function app.approval_rules(p_company uuid)
returns table (
  id uuid, request_type text, name text, chain text[],
  applies_when text, priority int, active boolean
)
language sql stable security definer set search_path = app, extensions, public, pg_temp as $$
  select
    p.id, p.request_type::text, p.name, p.chain::text[],
    trim(both ' ' from concat_ws(', ',
      case when p.min_amount_minor is not null
           then 'from NGN ' || to_char(p.min_amount_minor / 100, 'FM999,999,999') end,
      case when p.max_amount_minor is not null
           then 'up to NGN ' || to_char(p.max_amount_minor / 100, 'FM999,999,999') end,
      case when p.min_items is not null then p.min_items || ' items or more' end,
      case when p.max_items is not null then 'up to ' || p.max_items || ' items' end)),
    p.priority, p.active
  from app.approval_policies p
  where p.company_id = p_company and app.is_member(p_company)
  order by p.request_type, p.priority, p.name
$$;

grant execute on function app.approval_rules(uuid) to authenticated;

-- Which chain would apply to a given request, so somebody can check a rule
-- before relying on it rather than discovering it on a live approval.
create or replace function app.which_chain(
  p_company uuid, p_type app.request_type, p_amount_minor bigint default null, p_items int default null
) returns jsonb
language plpgsql stable security definer set search_path = app, extensions, public, pg_temp as $$
declare v_p app.approval_policies%rowtype;
begin
  if not app.is_member(p_company) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;

  select * into v_p from app.approval_policies
  where company_id = p_company and request_type = p_type and active
    and (min_amount_minor is null or coalesce(p_amount_minor, 0) >= min_amount_minor)
    and (max_amount_minor is null or coalesce(p_amount_minor, 0) <= max_amount_minor)
    and (min_items is null or coalesce(p_items, 0) >= min_items)
    and (max_items is null or coalesce(p_items, 0) <= max_items)
  order by priority
  limit 1;

  if not found then
    return jsonb_build_object(
      'found', false,
      'note', 'No rule matches, so this would go straight to an owner or admin.');
  end if;

  return jsonb_build_object(
    'found', true, 'name', v_p.name, 'chain', v_p.chain::text[],
    'signatures', array_length(v_p.chain, 1));
end $$;

grant execute on function app.which_chain(uuid, app.request_type, bigint, int) to authenticated;

-- A company with no rules at all has no hierarchy, and nobody notices until a
-- request sits unapproved. Seeded on creation, like everything else that must
-- exist from day one.
create or replace function app.seed_approval_policies(p_company uuid)
returns void
language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  if exists (select 1 from app.approval_policies where company_id = p_company) then
    return;
  end if;

  insert into app.approval_policies
    (company_id, request_type, name, chain, min_amount_minor, max_amount_minor, priority)
  values
    -- Purchases: one signature under half a million naira, two above.
    (p_company, 'purchase', 'Purchases under NGN 500,000',
     array['manager']::app.role_type[], null, 50000000, 10),
    (p_company, 'purchase', 'Purchases of NGN 500,000 and above',
     array['manager','admin']::app.role_type[], 50000000, null, 20),
    -- Moving assets between sites: one manager.
    (p_company, 'transfer', 'Any transfer between locations',
     array['manager']::app.role_type[], null, null, 10),
    -- Repairs: cheap ones are routine, expensive ones are a decision.
    (p_company, 'repair', 'Repairs under NGN 200,000',
     array['manager']::app.role_type[], null, 20000000, 10),
    (p_company, 'repair', 'Repairs of NGN 200,000 and above',
     array['manager','admin']::app.role_type[], 20000000, null, 20),
    -- Writing something off is always two signatures. It is the one action
    -- that removes an asset from the register permanently.
    (p_company, 'disposal', 'Any disposal',
     array['manager','owner']::app.role_type[], null, null, 10);
end $$;

create or replace function app.companies_seed_approvals()
returns trigger language plpgsql security definer set search_path = app, extensions, public, pg_temp as $$
begin
  perform app.seed_approval_policies(new.id);
  return new;
end $$;

drop trigger if exists companies_approval_guard on app.companies;
create trigger companies_approval_guard
  after insert on app.companies
  for each row execute function app.companies_seed_approvals();

do $$
declare c record;
begin
  for c in select id from app.companies loop
    perform app.seed_approval_policies(c.id);
  end loop;
end $$;
