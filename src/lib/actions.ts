'use server';

import { parseSheet } from './sheet';

/**
 * Server actions for movement.
 *
 * Every one of these calls a database function rather than issuing INSERTs
 * and UPDATEs from here. That is the point: app.accept_transfer() moves every
 * line, opens discrepancies, stamps the waybill and writes the audit rows in
 * one transaction. Doing the same work from JavaScript would mean a dropped
 * connection halfway through leaves assets belonging to no register at all.
 *
 * Authorisation is not checked here either. The functions are SECURITY DEFINER
 * and check it themselves — only someone who can act at the destination may
 * accept a delivery, and so on. A check in this file would be a second opinion
 * that could drift from the first.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { server } from './supabase';

const sb = () => server(cookies());

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function createTransfer(formData: FormData): Promise<void> {
  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const driver = String(formData.get('driver') ?? '');
  const plate = String(formData.get('plate') ?? '');
  const assetIds = formData.getAll('asset').map(String);

  if (!from || !to || assetIds.length === 0) {
    redirect('/transfers/new?error=' + encodeURIComponent('Pick at least one asset and a destination.'));
  }

  const supabase = sb();

  const { data: company } = await supabase.from('locations').select('company_id').eq('id', from).single();
  if (!company) redirect('/transfers/new?error=' + encodeURIComponent('That origin could not be read.'));

  const { data: ref } = await supabase.rpc('next_doc_number', {
    p_company: company.company_id,
    p_kind: 'request',
  });

  const { data: transfer, error } = await supabase
    .from('transfers')
    .insert({
      company_id: company.company_id,
      reference: ref ?? `TR-${Date.now()}`,
      from_location: from,
      to_location: to,
      status: 'draft',
      reason: reason || null,
      driver_name: driver || null,
      vehicle_reg: plate || null,
    })
    .select('id')
    .single();

  if (error || !transfer) {
    redirect('/transfers/new?error=' + encodeURIComponent(error?.message ?? 'Could not create the transfer.'));
  }

  const { error: lineErr } = await supabase.from('transfer_lines').insert(
    assetIds.map((asset_id) => ({
      company_id: company.company_id,
      transfer_id: transfer.id,
      asset_id,
    }))
  );

  if (lineErr) {
    redirect('/transfers/new?error=' + encodeURIComponent(lineErr.message));
  }

  revalidatePath('/transfers');
  redirect(`/transfers/${transfer.id}`);
}

/** Approve without a request chain — owners and admins only, per RLS. */
export async function approveTransfer(id: string): Promise<void> {
  await sb().from('transfers').update({ status: 'approved' }).eq('id', id);
  revalidatePath(`/transfers/${id}`);
}

export async function dispatchTransfer(id: string): Promise<void> {
  const supabase = sb();
  const { error } = await supabase.rpc('dispatch_transfer', { p_transfer: id });

  if (error) {
    revalidatePath(`/transfers/${id}`);
    redirect(`/transfers/${id}?error=` + encodeURIComponent(error.message));
  }

  // Freeze the document at the moment of dispatch. Without this the waybill
  // page has nothing to render and "Print the waybill" always says none has
  // been issued — the snapshot table existed but nothing ever wrote to it.
  //
  // A failure here must not undo the dispatch: the assets have left the origin
  // register, which is the fact that matters. The document can be reissued.
  const { error: docError } = await supabase.rpc('issue_waybill_document', {
    p_transfer: id,
  });

  revalidatePath(`/transfers/${id}`);
  revalidatePath('/assets');

  redirect(docError
    ? `/transfers/${id}?error=` + encodeURIComponent(
        `Dispatched, but the waybill could not be prepared: ${docError.message}`)
    : `/transfers/${id}?dispatched=1`);
}

/** Reissuing after a correction. Creates a new revision; the original stays. */
export async function reissueWaybill(id: string): Promise<void> {
  const { error } = await sb().rpc('issue_waybill_document', { p_transfer: id });
  revalidatePath(`/transfers/${id}/waybill`);
  redirect(error
    ? `/transfers/${id}?error=${encodeURIComponent(error.message)}`
    : `/transfers/${id}/waybill`);
}

export async function acceptTransfer(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const flagged = formData.getAll('flag').map(String);
  const notes = String(formData.get('notes') ?? '');

  const { error } = await sb().rpc('accept_transfer', {
    p_transfer: id,
    p_flagged: flagged,
    p_notes: notes || null,
  });

  revalidatePath(`/transfers/${id}`);
  revalidatePath('/transfers');
  revalidatePath('/discrepancies');
  revalidatePath('/assets');

  if (error) redirect(`/transfers/${id}?error=` + encodeURIComponent(error.message));
  redirect(`/transfers/${id}?done=1`);
}

export async function cancelTransfer(id: string): Promise<void> {
  await sb().from('transfers').update({ status: 'cancelled' }).eq('id', id);
  revalidatePath(`/transfers/${id}`);
}

/* ------------------------------------------------------------- inventory --
 * Stock never changes by UPDATE. Every movement is a row in an append-only
 * ledger and the balance is derived, so "why is there 3,910 litres?" always
 * has an answer with a name and a timestamp against it.
 */

export async function issueStock(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('issue_stock', {
    p_item: String(formData.get('item')),
    p_location: String(formData.get('location')),
    p_qty: Number(formData.get('qty')),
    p_asset: (formData.get('asset') as string) || null,
    p_meter: formData.get('meter') ? Number(formData.get('meter')) : null,
    p_job_ref: (formData.get('job') as string) || null,
    p_reason: (formData.get('reason') as string) || null,
  });
  revalidatePath('/inventory');
  redirect(error ? `/inventory?error=${encodeURIComponent(error.message)}` : '/inventory?done=issued');
}

export async function transferStock(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('transfer_stock', {
    p_item: String(formData.get('item')),
    p_from: String(formData.get('from')),
    p_to: String(formData.get('to')),
    p_qty: Number(formData.get('qty')),
    p_reason: (formData.get('reason') as string) || null,
  });
  revalidatePath('/inventory');
  redirect(error ? `/inventory?error=${encodeURIComponent(error.message)}` : '/inventory?done=moved');
}

export async function receiveStock(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('post_stock_movement', {
    p_item: String(formData.get('item')),
    p_location: String(formData.get('location')),
    p_kind: 'receipt',
    p_qty: Number(formData.get('qty')),
    p_reason: (formData.get('reason') as string) || 'Received',
  });
  revalidatePath('/inventory');
  redirect(error ? `/inventory?error=${encodeURIComponent(error.message)}` : '/inventory?done=received');
}

/* --------------------------------------------------------- field submissions
 * A link holder submits; a manager reviews. Nothing a link sends changes the
 * register on its own — review_submission() is what writes it.
 */

export async function reviewSubmission(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const accept = String(formData.get('decision')) === 'accept';
  const { error } = await sb().rpc('review_submission', {
    p_submission: id,
    p_accept: accept,
    p_note: (formData.get('note') as string) || null,
  });
  revalidatePath('/submissions');
  revalidatePath('/inventory');
  redirect(error ? `/submissions/${id}?error=${encodeURIComponent(error.message)}` : '/submissions?done=1');
}

export async function issueLink(formData: FormData): Promise<void> {
  const verbs = formData.getAll('verb').map(String);
  const supabase = sb();

  const location = String(formData.get('location'));
  const { data: loc } = await supabase.from('locations').select('company_id').eq('id', location).single();
  if (!loc) redirect('/people?error=' + encodeURIComponent('That location could not be read.'));

  // A holder is a person with no account: a storekeeper, a driver, site crew.
  const { data: holder, error: hErr } = await supabase
    .from('link_holders')
    .insert({
      company_id: loc.company_id,
      name: String(formData.get('name')),
      role_label: (formData.get('role') as string) || null,
      phone: (formData.get('phone') as string) || null,
      location_id: location,
    })
    .select('id')
    .single();

  if (hErr || !holder) redirect('/people?error=' + encodeURIComponent(hErr?.message ?? 'Could not add that person.'));

  const { data, error } = await supabase.rpc('issue_location_link', {
    p_company: loc.company_id,
    p_location: location,
    p_holder: holder.id,
    p_verbs: verbs,
  });

  revalidatePath('/people');
  if (error) redirect('/people?error=' + encodeURIComponent(error.message));

  // The token is returned once and only its hash is stored, so it is passed
  // straight back to be copied. It cannot be retrieved again.
  redirect('/people?token=' + encodeURIComponent(data?.url ?? '') + '&slug=' + encodeURIComponent(data?.slug ?? ''));
}

export async function revokeLink(id: string): Promise<void> {
  await sb().rpc('revoke_location_link', { p_link: id, p_reason: 'Revoked from the dashboard' });
  revalidatePath('/people');
}

/* ------------------------------------------------------------- lifecycle -- */

export async function logService(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('log_service', {
    p_asset: String(formData.get('asset')),
    p_kind: (formData.get('kind') as string) || 'Service',
    p_cost: formData.get('cost') ? Math.round(Number(formData.get('cost')) * 100) : null,
    p_vendor: (formData.get('vendor') as string) || null,
    p_note: (formData.get('note') as string) || null,
  });
  revalidatePath('/assets');
  if (error) redirect('/assets?error=' + encodeURIComponent(error.message));
}

export async function resolveDiscrepancy(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const { error } = await sb().rpc('resolve_discrepancy', {
    p_discrepancy: id,
    p_outcome: String(formData.get('outcome')),
    p_note: (formData.get('note') as string) || null,
  });
  revalidatePath('/transfers');
  revalidatePath('/assets');
  if (error) redirect('/transfers?error=' + encodeURIComponent(error.message));
}

export async function decideRequest(formData: FormData): Promise<void> {
  const id = String(formData.get('id'));
  const { error } = await sb().rpc('decide_request', {
    p_request: id,
    p_approve: String(formData.get('decision')) === 'approve',
    p_note: (formData.get('note') as string) || null,
  });
  revalidatePath('/requests');
  if (error) redirect('/requests?error=' + encodeURIComponent(error.message));
}

/* ========================================================================== */
/* Build B: lifecycle, procurement and reporting                              */
/* ========================================================================== */

export async function disposeAsset(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const reason = String(formData.get('reason') ?? '');
  const proceeds = String(formData.get('proceeds') ?? '').replace(/[^\d]/g, '');
  const evidence = String(formData.get('evidence') ?? '');
  const note = String(formData.get('note') ?? '');

  // The evidence rules live in app.dispose_asset(), not here. A theft with no
  // police reference is exactly the pattern an audit flags, so it is refused
  // by the database rather than by a form that could be bypassed.
  const { error } = await sb().rpc('dispose_asset', {
    p_asset: id,
    p_reason: reason,
    p_proceeds: proceeds ? Number(proceeds) * 100 : null,
    p_evidence: evidence || null,
    p_note: note || null,
  });

  revalidatePath('/assets');
  if (error) redirect(`/assets/${id}?error=` + encodeURIComponent(error.message));
  redirect('/assets?disposed=1');
}

export async function returnToService(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const outcome = String(formData.get('outcome') ?? '');
  const cost = String(formData.get('cost') ?? '').replace(/[^\d]/g, '');

  const { error } = await sb().rpc('return_to_service', {
    p_asset: id,
    p_outcome: outcome,
    p_cost: cost ? Number(cost) * 100 : null,
    p_note: (formData.get('note') as string) || null,
  });

  revalidatePath('/maintenance');
  revalidatePath('/assets');
  if (error) redirect('/maintenance?error=' + encodeURIComponent(error.message));
  redirect('/maintenance?returned=1');
}

export async function receiveGoods(formData: FormData): Promise<void> {
  const po = String(formData.get('po') ?? '');

  // Serials arrive as serial_<lineNo>_<index>. Grouping them by line matters:
  // receive_goods() refuses a serialised line whose serial count does not
  // match its quantity, which is the rule that stops twelve identical chairs
  // becoming twelve rows nobody can ever tell apart.
  const byLine: Record<string, string[]> = {};
  for (const [k, v] of formData.entries()) {
    if (!k.startsWith('serial_')) continue;
    const [, line] = k.split('_');
    const val = String(v).trim();
    if (!val) continue;
    (byLine[line] ??= []).push(val);
  }

  const payload = Object.entries(byLine).map(([line_no, serials]) => ({
    line_no: Number(line_no),
    serials,
  }));

  const { error } = await sb().rpc('receive_goods', {
    p_po: po,
    p_serials: payload,
    p_note: (formData.get('note') as string) || null,
  });

  revalidatePath('/purchase-orders');
  revalidatePath('/assets');
  if (error) redirect(`/purchase-orders/${po}?error=` + encodeURIComponent(error.message));
  redirect(`/purchase-orders/${po}?received=1`);
}

export async function createSupplier(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).single();
  if (!co) redirect('/suppliers?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.from('suppliers').insert({
    company_id: co.id,
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? '') || null,
    phone: String(formData.get('phone') ?? '') || null,
    supplies: String(formData.get('supplies') ?? '') || null,
  });

  revalidatePath('/suppliers');
  if (error) redirect('/suppliers?error=' + encodeURIComponent(error.message));
  redirect('/suppliers?added=1');
}



/* ========================================================================== */
/* Final: asset detail, requests, custody, settings                           */
/* ========================================================================== */

export async function handOver(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const holder = String(formData.get('holder') ?? '').trim();

  // "Assigned to" should mean a person accepted responsibility, not that
  // somebody typed a name. Recording the condition at handover is what
  // settles who damaged something when it comes back.
  const condition = String(formData.get('condition') ?? '');
  const { error } = await sb()
    .from('assets')
    .update({ holder: holder || null })
    .eq('id', id);

  revalidatePath(`/assets/${id}`);
  if (error) redirect(`/assets/${id}?error=` + encodeURIComponent(error.message));
  redirect(`/assets/${id}?handed=` + encodeURIComponent(condition));
}

export async function raiseRequest(formData: FormData): Promise<void> {
  const supabase = sb();
  const kind = String(formData.get('kind') ?? 'repair');
  const location = String(formData.get('location') ?? '');
  const amountRaw = String(formData.get('amount') ?? '').replace(/[^\d]/g, '');

  const { data: loc } = await supabase
    .from('locations').select('company_id').eq('id', location).maybeSingle();
  if (!loc) redirect('/requests/new?error=' + encodeURIComponent('That location could not be read.'));

  // The chain is chosen by app.match_policy() from the amount and item count.
  // Nothing here decides who approves; that is a row in approval_policies.
  const { error } = await supabase.rpc('raise_request', {
    p_company: loc.company_id,
    p_kind: kind,
    p_title: String(formData.get('title') ?? ''),
    p_detail: String(formData.get('detail') ?? '') || null,
    p_location: location,
    p_asset: String(formData.get('asset') ?? '') || null,
    p_amount: amountRaw ? Number(amountRaw) * 100 : null,
    p_items: Number(formData.get('items') ?? 1) || 1,
  });

  revalidatePath('/requests');
  if (error) redirect('/requests/new?error=' + encodeURIComponent(error.message));
  redirect('/requests?raised=1');
}

export async function updateCompany(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const { error } = await sb()
    .from('companies')
    .update({
      name: String(formData.get('name') ?? ''),
      registration_no: String(formData.get('rc') ?? '') || null,
      address: String(formData.get('address') ?? '') || null,
      phone: String(formData.get('phone') ?? '') || null,
      // The brand colour is NOT set here. This form is company details; the
      // appearance form owns the colour. Writing it from both meant saving a
      // phone number silently reset the theme to whatever was in a hidden
      // field when the page was rendered.
    })
    .eq('id', id);

  revalidatePath('/settings');
  if (error) redirect('/settings?error=' + encodeURIComponent(error.message));
  redirect('/settings?saved=1');
}

export async function createLocation(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/locations?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.from('locations').insert({
    company_id: co.id,
    name: String(formData.get('name') ?? ''),
    city: String(formData.get('city') ?? '') || null,
    kind: 'physical',
  });

  revalidatePath('/locations');
  if (error) redirect('/locations?error=' + encodeURIComponent(error.message));
  redirect('/locations?added=1');
}

export async function archiveLocation(id: string): Promise<void> {
  // Locations archive, never delete: waybills and audit rows reference them by
  // id, and dropping the row would turn every one into a dangling pointer.
  const { error } = await sb().rpc('archive_location', { p_location: id });
  revalidatePath('/locations');
  if (error) redirect('/locations?error=' + encodeURIComponent(error.message));
}

export async function sweepLocation(id: string): Promise<void> {
  const { error } = await sb().rpc('sweep_location', { p_location: id });
  revalidatePath('/locations');
  if (error) redirect('/locations?error=' + encodeURIComponent(error.message));
  redirect('/locations?swept=1');
}

export async function createAsset(formData: FormData): Promise<void> {
  const supabase = sb();
  const location = String(formData.get('location') ?? '');
  const { data: loc } = await supabase
    .from('locations').select('company_id').eq('id', location).maybeSingle();
  if (!loc) redirect('/assets/new?error=' + encodeURIComponent('That location could not be read.'));

  const cost = String(formData.get('cost') ?? '').replace(/[^\d]/g, '');
  const model = String(formData.get('model') ?? '');

  const { data: asset, error } = await supabase
    .from('assets')
    .insert({
      company_id: loc.company_id,
      tag: String(formData.get('tag') ?? '').trim(),
      name: String(formData.get('name') ?? '').trim(),
      serial_no: String(formData.get('serial') ?? '').trim() || null,
      model_id: model || null,
      location_id: location,
      status: 'active',
      holder: String(formData.get('holder') ?? '').trim() || null,
      acquired_on: String(formData.get('acquired') ?? '') || null,
      meter_value: Number(formData.get('meter') ?? 0) || 0,
      meter_unit: String(formData.get('meter_unit') ?? '') || null,
    })
    .select('id')
    .single();

  if (error || !asset) {
    redirect('/assets/new?error=' + encodeURIComponent(error?.message ?? 'Could not add the asset.'));
  }

  // Cost goes in its own table, so an asset added by someone who cannot see
  // costs simply has no financial row rather than a zero.
  if (cost) {
    await supabase.from('asset_financials').insert({
      asset_id: asset.id,
      company_id: loc.company_id,
      purchase_cost_minor: Number(cost) * 100,
      invoice_ref: String(formData.get('invoice') ?? '') || null,
    });
  }

  revalidatePath('/assets');
  redirect(`/assets/${asset.id}?added=1`);
}

export async function createCategory(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/catalog?error=' + encodeURIComponent('No company in scope.'));
  const { error } = await supabase.from('categories').insert({
    company_id: co.id,
    name: String(formData.get('name') ?? '').trim(),
  });
  revalidatePath('/catalog');
  if (error) redirect('/catalog?error=' + encodeURIComponent(error.message));
  redirect('/catalog?added=1');
}

export async function createBrand(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/catalog?error=' + encodeURIComponent('No company in scope.'));
  const { error } = await supabase.from('brands').insert({
    company_id: co.id,
    name: String(formData.get('name') ?? '').trim(),
  });
  revalidatePath('/catalog');
  if (error) redirect('/catalog?error=' + encodeURIComponent(error.message));
  redirect('/catalog?added=1');
}

export async function createModel(formData: FormData): Promise<void> {
  const supabase = sb();
  const sub = String(formData.get('sub_category') ?? '');
  const { data: s } = await supabase
    .from('sub_categories').select('company_id').eq('id', sub).maybeSingle();
  if (!s) redirect('/catalog?error=' + encodeURIComponent('Pick a type first.'));

  const rate = String(formData.get('rate') ?? '').trim();
  const { error } = await supabase.from('models').insert({
    company_id: s.company_id,
    sub_category_id: sub,
    brand_id: String(formData.get('brand') ?? ''),
    name: String(formData.get('name') ?? '').trim(),
    service_life_years: Number(formData.get('life') ?? 0) || null,
    warranty_months: Number(formData.get('warranty') ?? 0) || null,
    service_interval: Number(formData.get('interval') ?? 0) || null,
    service_interval_unit: String(formData.get('interval_unit') ?? '') || null,
    // Typed, never parsed out of a description: "1104A-44TG2" would otherwise
    // yield 1104 litres an hour.
    consumption_rate: rate ? Number(rate) : null,
    consumption_unit: rate ? 'per_hour' : null,
  });
  revalidatePath('/catalog');
  if (error) redirect('/catalog?error=' + encodeURIComponent(error.message));
  redirect('/catalog?added=1');
}

export async function createSubCategory(formData: FormData): Promise<void> {
  const supabase = sb();
  const cat = String(formData.get('category') ?? '');
  const { data: c } = await supabase
    .from('categories').select('company_id').eq('id', cat).maybeSingle();
  if (!c) redirect('/catalog?error=' + encodeURIComponent('Pick a category first.'));
  const { error } = await supabase.from('sub_categories').insert({
    company_id: c.company_id,
    category_id: cat,
    name: String(formData.get('name') ?? '').trim(),
  });
  revalidatePath('/catalog');
  if (error) redirect('/catalog?error=' + encodeURIComponent(error.message));
  redirect('/catalog?added=1');
}

export async function createStockItem(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/inventory?error=' + encodeURIComponent('No company in scope.'));

  const unit = String(formData.get('unit') ?? 'units');
  const { error } = await supabase.from('stock_items').insert({
    company_id: co.id,
    sku: String(formData.get('sku') ?? '').trim(),
    name: String(formData.get('name') ?? '').trim(),
    category: String(formData.get('category') ?? '') || null,
    unit,
    // Litres and kilogrammes divide; helmets do not. Getting this wrong is how
    // a register ends up recording half a helmet.
    is_divisible: ['litres', 'kg', 'metres', 'm'].includes(unit.toLowerCase()),
    reorder_point: Number(formData.get('reorder') ?? 0) || 0,
    unit_cost_minor: Number(String(formData.get('cost') ?? '').replace(/[^\d]/g, '') || 0) * 100,
    variance_tolerance_pct: Number(formData.get('tolerance') ?? 0) || 0,
  });
  revalidatePath('/inventory');
  if (error) redirect('/inventory?error=' + encodeURIComponent(error.message));
  redirect('/inventory?added=1');
}

/* ========================================================================== */
/* Sign-up, invitations and deletion                                          */
/* ========================================================================== */

export async function createCompanyAccount(formData: FormData): Promise<void> {
  const { data, error } = await sb().rpc('signup_company', {
    p_company_name: String(formData.get('company') ?? ''),
    p_slug: String(formData.get('slug') ?? '') || null,
    p_full_name: String(formData.get('name') ?? '') || null,
    p_registration: String(formData.get('rc') ?? '') || null,
    p_address: String(formData.get('address') ?? '') || null,
  });

  if (error) redirect('/onboarding?error=' + encodeURIComponent(error.message));
  // A tenant lives on its own subdomain, so this is a hard navigation to a
  // different origin rather than a client-side transition.
  redirect((data as any)?.url ?? '/');
}

export async function inviteMember(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/people?error=' + encodeURIComponent('No company in scope.'));

  const { data, error } = await supabase.rpc('invite_member', {
    p_company: co.id,
    p_email: String(formData.get('email') ?? ''),
    p_role: String(formData.get('role') ?? 'requester'),
    p_location: String(formData.get('location') ?? '') || null,
  });

  revalidatePath('/people');
  if (error) redirect('/people?error=' + encodeURIComponent(error.message));
  // Shown once. Nothing but the hash is stored, so it cannot be retrieved.
  redirect(`/people?invite=${encodeURIComponent((data as any)?.path ?? '')}`);
}

export async function revokeInvitation(id: string): Promise<void> {
  const { error } = await sb().rpc('revoke_invitation', { p_id: id });
  revalidatePath('/people');
  if (error) redirect('/people?error=' + encodeURIComponent(error.message));
}

export async function acceptInvitation(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const { data, error } = await sb().rpc('accept_invitation', { p_token: token });
  if (error) redirect(`/join/${token}?error=` + encodeURIComponent(error.message));
  redirect((data as any)?.url ?? '/');
}

/**
 * Deletion. Every one of these calls a database function that checks what
 * refers to the row first — so a refusal arrives with a reason and a way
 * forward rather than a foreign key error nobody can act on.
 */
async function tryDelete(fn: string, arg: Record<string, unknown>, back: string) {
  const { error } = await sb().rpc(fn, arg);
  revalidatePath(back);
  redirect(error ? `${back}?error=${encodeURIComponent(error.message)}` : `${back}?deleted=1`);
}

export const deleteLocation = (id: string) => tryDelete('delete_location', { p_id: id }, '/locations');
export const deleteModel = (id: string) => tryDelete('delete_model', { p_id: id }, '/catalog');
export const deleteBrand = (id: string) => tryDelete('delete_brand', { p_id: id }, '/catalog');
export const deleteSubCategory = (id: string) => tryDelete('delete_sub_category', { p_id: id }, '/catalog');
export const deleteCategory = (id: string) => tryDelete('delete_category', { p_id: id }, '/catalog');
export const deleteStockItem = (id: string) => tryDelete('delete_stock_item', { p_id: id }, '/inventory');
export const archiveStockItem = (id: string) => tryDelete('archive_stock_item', { p_id: id }, '/inventory');
export const deleteTransferDraft = (id: string) => tryDelete('delete_transfer', { p_id: id }, '/transfers');
export const deleteSupplier = (id: string) => tryDelete('delete_supplier', { p_id: id }, '/suppliers');
export const archiveSupplier = (id: string) => tryDelete('archive_supplier', { p_id: id }, '/suppliers');
export const deleteLinkHolder = (id: string) => tryDelete('delete_link_holder', { p_id: id }, '/people');

export async function removeMember(userId: string): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/people?error=' + encodeURIComponent('No company in scope.'));
  const { error } = await supabase.rpc('remove_member', { p_company: co.id, p_user: userId });
  revalidatePath('/people');
  redirect(error ? `/people?error=${encodeURIComponent(error.message)}` : '/people?removed=1');
}

export async function closeCompany(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/settings?error=' + encodeURIComponent('No company in scope.'));
  const { error } = await supabase.rpc('archive_company', {
    p_company: co.id,
    p_confirm: String(formData.get('confirm') ?? ''),
  });
  if (error) redirect('/settings?error=' + encodeURIComponent(error.message));
  redirect('/auth/sign-out');
}

/**
 * Starting a payment.
 *
 * The amount is computed by the database from the register, never taken from
 * the form — a client-supplied amount is a client-supplied discount.
 */
export async function startPayment(): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/billing?error=' + encodeURIComponent('No company in scope.'));

  const { data: begun, error } = await supabase.rpc('begin_payment', { p_company: co.id });
  if (error) redirect('/billing?error=' + encodeURIComponent(error.message));

  const { initializeTransaction, paystackConfigured } = await import('./paystack');
  if (!paystackConfigured()) {
    redirect('/billing?error=' + encodeURIComponent(
      'Payments are not connected yet. Email us and we will invoice you directly.'));
  }

  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';
  const result = await initializeTransaction({
    email: (begun as any).email,
    amountMinor: (begun as any).amount_minor,
    reference: (begun as any).reference,
    companyId: co.id,
    callbackUrl: `https://${root}/billing?returned=1`,
  });

  if (!result.ok) redirect('/billing?error=' + encodeURIComponent(result.error));
  redirect(result.authorization_url);
}

export async function submitPaymentProof(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/billing?error=' + encodeURIComponent('No company in scope.'));

  const naira = String(formData.get('amount') ?? '').replace(/[^\d]/g, '');
  if (!naira) redirect('/billing/transfer?error=' + encodeURIComponent('Enter the amount you sent.'));

  const { error } = await supabase.rpc('submit_payment_proof', {
    p_company: co.id,
    p_amount: Number(naira) * 100,
    p_paid_on: String(formData.get('paid_on') ?? ''),
    p_bank: String(formData.get('bank') ?? '') || null,
    p_sender: String(formData.get('sender') ?? '') || null,
    p_narration: String(formData.get('narration') ?? '') || null,
    p_receipt_path: String(formData.get('receipt_path') ?? '') || null,
    p_receipt_name: String(formData.get('receipt_name') ?? '') || null,
  });

  revalidatePath('/billing');
  if (error) redirect('/billing/transfer?error=' + encodeURIComponent(error.message));
  redirect('/billing?recorded=1');
}

export async function reviewPaymentProof(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('verify_payment_proof', {
    p_id: String(formData.get('id') ?? ''),
    p_approve: String(formData.get('decision') ?? '') === 'approve',
    p_note: String(formData.get('note') ?? '') || null,
  });
  revalidatePath('/admin/payments');
  redirect(error ? `/admin/payments?error=${encodeURIComponent(error.message)}` : '/admin/payments?done=1');
}

export async function savePlatformSettings(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('update_platform_settings', {
    p_bank: String(formData.get('bank') ?? ''),
    p_account_name: String(formData.get('account_name') ?? ''),
    p_account_number: String(formData.get('account_number') ?? ''),
    p_instructions: String(formData.get('instructions') ?? ''),
  });
  revalidatePath('/admin/payments');
  revalidatePath('/billing/transfer');
  redirect(error ? `/admin/payments?error=${encodeURIComponent(error.message)}` : '/admin/payments?saved=1');
}

export async function saveTheme(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/settings?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.rpc('set_company_theme', {
    p_company: co.id,
    p_brand: String(formData.get('brand') ?? '') || null,
    p_accent: String(formData.get('accent') ?? '') || null,
    p_mode: String(formData.get('mode') ?? '') || null,
    p_footer: String(formData.get('footer') ?? '') || null,
    p_show_logo: formData.get('show_logo') === 'on',
  });

  revalidatePath('/settings');
  redirect(error ? `/settings?error=${encodeURIComponent(error.message)}` : '/settings?saved=1');
}

export async function saveLogo(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/settings?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.rpc('set_company_logo', {
    p_company: co.id,
    p_path: String(formData.get('logo_path') ?? '') || null,
  });

  revalidatePath('/settings');
  revalidatePath('/dashboard');
  redirect(error ? `/settings?error=${encodeURIComponent(error.message)}` : '/settings?saved=1');
}

export async function saveViewPreferences(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/settings?error=' + encodeURIComponent('No company in scope.'));

  const columns = formData.getAll('column').map(String);
  const loc = String(formData.get('default_location') ?? '');

  const { error } = await supabase.rpc('save_view_preferences', {
    p_company: co.id,
    p_landing: String(formData.get('landing') ?? '') || null,
    p_density: String(formData.get('density') ?? '') || null,
    p_columns: columns,
    // The sentinel is how "all locations" is told apart from "no change" —
    // a null here would mean the latter.
    p_location: loc || '00000000-0000-0000-0000-000000000000',
    p_hide_retired: formData.get('hide_retired') === 'on',
  });

  revalidatePath('/settings');
  revalidatePath('/assets');
  redirect(error ? `/settings?error=${encodeURIComponent(error.message)}` : '/settings?saved=1');
}

/* ========================================================================== */
/* Platform: free access and provisioning                                     */
/* ========================================================================== */

export async function toggleBilling(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('set_billing_enabled', {
    p_on: String(formData.get('on') ?? '') === 'yes',
    p_notice: String(formData.get('notice') ?? '') || null,
  });
  revalidatePath('/admin/companies');
  revalidatePath('/billing');
  redirect(error ? `/admin/companies?error=${encodeURIComponent(error.message)}` : '/admin/companies?saved=1');
}

export async function setComped(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('set_comped', {
    p_company: String(formData.get('company') ?? ''),
    p_on: String(formData.get('on') ?? '') === 'yes',
    p_reason: String(formData.get('reason') ?? '') || null,
    p_until: String(formData.get('until') ?? '') || null,
  });
  revalidatePath('/admin/companies');
  redirect(error ? `/admin/companies?error=${encodeURIComponent(error.message)}` : '/admin/companies?saved=1');
}

export async function provisionCompany(formData: FormData): Promise<void> {
  const { data, error } = await sb().rpc('provision_company', {
    p_owner_email: String(formData.get('email') ?? ''),
    p_owner_name: String(formData.get('name') ?? ''),
    p_company_name: String(formData.get('company') ?? ''),
    p_slug: String(formData.get('slug') ?? '') || null,
    p_comp: formData.get('comped') === 'on',
    p_comp_reason: String(formData.get('reason') ?? '') || 'Early customer',
    p_registration: String(formData.get('rc') ?? '') || null,
    p_address: String(formData.get('address') ?? '') || null,
  });

  revalidatePath('/admin/companies');
  if (error) redirect('/admin/companies?error=' + encodeURIComponent(error.message));
  redirect(`/admin/companies?created=${encodeURIComponent((data as any)?.url ?? '')}`);
}

/* ========================================================================== */
/* Specifications                                                             */
/* ========================================================================== */

export async function saveModelSpec(formData: FormData): Promise<void> {
  const modelId = String(formData.get('model') ?? '');

  // Every attribute field is prefixed so it can be told apart from the rest of
  // the form without knowing the attribute codes in advance.
  const values: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('attr_')) values[k.slice(5)] = String(v);
  }

  const { error } = await sb().rpc('set_model_attributes', {
    p_model: modelId,
    p_values: values,
  });

  revalidatePath('/catalog');
  redirect(error
    ? `/catalog/${modelId}?error=${encodeURIComponent(error.message)}`
    : `/catalog/${modelId}?saved=1`);
}

export async function saveAssetAttribute(formData: FormData): Promise<void> {
  const assetId = String(formData.get('asset') ?? '');
  const { error } = await sb().rpc('set_asset_attribute', {
    p_asset: assetId,
    p_code: String(formData.get('code') ?? ''),
    p_value: String(formData.get('value') ?? ''),
    p_note: String(formData.get('note') ?? '') || null,
  });
  revalidatePath(`/assets/${assetId}`);
  redirect(error
    ? `/assets/${assetId}?error=${encodeURIComponent(error.message)}`
    : `/assets/${assetId}?saved=1`);
}

export async function saveAttribute(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/catalog/attributes?error=' + encodeURIComponent('No company in scope.'));

  const choices = String(formData.get('choices') ?? '')
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const { error } = await supabase.rpc('upsert_attribute', {
    p_company: co.id,
    p_category: String(formData.get('category') ?? '') || null,
    p_code: String(formData.get('code') ?? ''),
    p_label: String(formData.get('label') ?? ''),
    p_kind: String(formData.get('kind') ?? 'text'),
    p_unit: String(formData.get('unit') ?? '') || null,
    p_choices: choices,
    p_required: formData.get('required') === 'on',
    p_filterable: formData.get('filterable') === 'on',
    p_help: String(formData.get('help') ?? '') || null,
    p_sort: Number(formData.get('sort') ?? 100) || 100,
  });

  revalidatePath('/catalog/attributes');
  redirect(error
    ? `/catalog/attributes?error=${encodeURIComponent(error.message)}`
    : '/catalog/attributes?saved=1');
}

export async function deleteAttribute(id: string): Promise<void> {
  const { error } = await sb().rpc('delete_attribute', { p_id: id });
  revalidatePath('/catalog/attributes');
  redirect(error
    ? `/catalog/attributes?error=${encodeURIComponent(error.message)}`
    : '/catalog/attributes?deleted=1');
}

export async function seedAttributes(): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/catalog/attributes?error=' + encodeURIComponent('No company in scope.'));
  const { data, error } = await supabase.rpc('seed_attributes', { p_company: co.id });
  revalidatePath('/catalog/attributes');
  redirect(error
    ? `/catalog/attributes?error=${encodeURIComponent(error.message)}`
    : `/catalog/attributes?seeded=${data ?? 0}`);
}

/**
 * Applying a starter pack.
 *
 * Distinct from seedAttributes, which matches attributes onto categories a
 * company already has. A pack creates the category, a type under it, and the
 * attributes together — for a company starting from nothing, which is most of
 * them on day one.
 */
export async function applyAttributePack(pack: string): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/catalog/attributes?error=' + encodeURIComponent('No company in scope.'));

  const { data, error } = await supabase.rpc('apply_attribute_pack', {
    p_company: co.id,
    p_pack: pack,
  });

  revalidatePath('/catalog/attributes');
  revalidatePath('/catalog');
  redirect(error
    ? `/catalog/attributes?error=${encodeURIComponent(error.message)}`
    : `/catalog/attributes?pack=${encodeURIComponent((data as any)?.category ?? pack)}`);
}

/**
 * Branch import.
 *
 * Parsing happens here rather than in the database, because a spreadsheet is a
 * human artefact: headers are capitalised differently, columns are named
 * "S/N" or "Serial No.", and someone always pastes a trailing blank line.
 * Being generous about that is the difference between a customer onboarding
 * and a customer giving up.
 */
export async function previewBranchImport(formData: FormData): Promise<void> {
  const raw = String(formData.get('sheet') ?? '').trim();
  const branch = String(formData.get('branch') ?? '').trim();
  const existing = String(formData.get('existing') ?? '');

  if (!raw) redirect('/import?error=' + encodeURIComponent('Paste your rows first.'));
  if (!branch && !existing) {
    redirect('/import?error=' + encodeURIComponent('Name the branch, or pick an existing one.'));
  }

  const { rows } = parseSheet(raw);
  if (!rows.length) {
    redirect('/import?error=' + encodeURIComponent(
      'No rows found. The first line should be your column names.'));
  }

  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/import?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.rpc('import_branch', {
    p_company: co.id,
    p_location_name: branch || 'existing',
    p_rows: rows,
    p_commit: false,
    p_location_id: existing || null,
    p_city: String(formData.get('city') ?? '') || null,
  });

  if (error) redirect('/import?error=' + encodeURIComponent(error.message));

  // The preview is held in the URL rather than a session: a refresh should show
  // the same preview, and nothing has been written yet to lose.
  const qs = new URLSearchParams({
    branch, existing, city: String(formData.get('city') ?? ''), sheet: raw,
  });
  redirect(`/import/review?${qs.toString()}`);
}

export async function commitBranchImport(formData: FormData): Promise<void> {
  const raw = String(formData.get('sheet') ?? '');
  const branch = String(formData.get('branch') ?? '').trim();
  const existing = String(formData.get('existing') ?? '');

  const { rows } = parseSheet(raw);
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/import?error=' + encodeURIComponent('No company in scope.'));

  const { data, error } = await supabase.rpc('import_branch', {
    p_company: co.id,
    p_location_name: branch || 'existing',
    p_rows: rows,
    p_commit: true,
    p_location_id: existing || null,
    p_city: String(formData.get('city') ?? '') || null,
  });

  revalidatePath('/assets');
  revalidatePath('/locations');
  revalidatePath('/catalog');

  if (error) redirect('/import?error=' + encodeURIComponent(error.message));
  redirect(`/assets?imported=${(data as any)?.assets ?? 0}`);
}

export async function setMemberRole(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/people?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.rpc('set_member_role', {
    p_company: co.id,
    p_user: String(formData.get('user') ?? ''),
    p_role: String(formData.get('role') ?? ''),
    p_location: String(formData.get('location') ?? '') || null,
  });

  revalidatePath('/people');
  redirect(error ? `/people?error=${encodeURIComponent(error.message)}` : '/people?role=1');
}

export async function updateAsset(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const supabase = sb();

  // Only fields the form actually sent. A disabled input submits nothing, so
  // a requester's form cannot carry a tag or serial at all — the trigger is
  // the real guard, but not sending them avoids a confusing refusal.
  const patch: Record<string, unknown> = {
    name: String(formData.get('name') ?? '').trim(),
    holder: String(formData.get('holder') ?? '').trim() || null,
    model_id: String(formData.get('model') ?? '') || null,
    location_id: String(formData.get('location') ?? '') || null,
    status: String(formData.get('status') ?? 'active'),
    notes: String(formData.get('notes') ?? '').trim() || null,
    meter_value: Number(formData.get('meter') ?? 0) || 0,
    meter_unit: String(formData.get('meter_unit') ?? '') || null,
  };

  if (formData.get('tag')) patch.tag = String(formData.get('tag')).trim();
  if (formData.get('serial')) patch.serial_no = String(formData.get('serial')).trim();

  const { error } = await supabase.from('assets').update(patch).eq('id', id);

  revalidatePath(`/assets/${id}`);
  revalidatePath('/assets');
  redirect(error ? `/assets/${id}/edit?error=${encodeURIComponent(error.message)}` : `/assets/${id}?saved=1`);
}

export async function updateMyProfile(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('update_my_profile', {
    p_full_name: String(formData.get('full_name') ?? ''),
    p_phone: String(formData.get('phone') ?? '') || null,
    p_job_title: String(formData.get('job_title') ?? '') || null,
  });
  revalidatePath('/profile');
  revalidatePath('/', 'layout');
  redirect(error ? `/profile?error=${encodeURIComponent(error.message)}` : '/profile?saved=1');
}

export async function renameCompany(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/settings?error=' + encodeURIComponent('No company in scope.'));
  const { error } = await supabase.rpc('rename_company', {
    p_company: co.id,
    p_name: String(formData.get('name') ?? ''),
  });
  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  redirect(error ? `/settings?error=${encodeURIComponent(error.message)}` : '/settings?saved=1');
}

export async function resendInvitation(id: string): Promise<void> {
  const { data, error } = await sb().rpc('resend_invitation', { p_id: id });
  revalidatePath('/people');
  redirect(error
    ? `/people?error=${encodeURIComponent(error.message)}`
    : `/people?invite=${encodeURIComponent((data as any)?.path ?? '')}`);
}

/**
 * Accepting an invitation without the original link.
 *
 * Somebody who was invited, confirmed their email, and came back no longer has
 * the token to hand. The invitation was bound to their address, so accepting
 * by address grants nothing the token would not have — and it stops a
 * confirmed invitee being stranded on a page offering to found a company.
 */
export async function acceptMyInvitation(): Promise<void> {
  const { data, error } = await sb().rpc('accept_my_invitation');
  if (error) redirect('/auth/landing?error=' + encodeURIComponent(error.message));
  redirect((data as any)?.url ?? '/auth/landing');
}
