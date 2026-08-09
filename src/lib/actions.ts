'use server';

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
  const { error } = await sb().rpc('dispatch_transfer', { p_transfer: id });
  revalidatePath(`/transfers/${id}`);
  revalidatePath('/assets');
  if (error) redirect(`/transfers/${id}?error=` + encodeURIComponent(error.message));
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

export async function importAssets(formData: FormData): Promise<void> {
  const raw = String(formData.get('csv') ?? '').trim();
  const location = String(formData.get('location') ?? '');
  if (!raw || !location) {
    redirect('/import?error=' + encodeURIComponent('Paste some rows and choose a location.'));
  }

  const supabase = sb();
  const { data: loc } = await supabase
    .from('locations')
    .select('id, company_id')
    .eq('id', location)
    .single();
  if (!loc) redirect('/import?error=' + encodeURIComponent('That location could not be read.'));

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iTag = idx('tag');
  const iName = idx('name');
  const iSerial = idx('serial');

  if (iTag < 0 || iName < 0) {
    redirect(
      '/import?error=' +
        encodeURIComponent('The first row must name the columns, and must include tag and name.')
    );
  }

  const rows = lines.slice(1).map((l) => {
    const c = l.split(',').map((x) => x.trim());
    return {
      company_id: loc.company_id,
      location_id: loc.id,
      tag: c[iTag],
      name: c[iName],
      serial_no: iSerial >= 0 ? c[iSerial] || null : null,
      status: 'active' as const,
    };
  });

  // Insert as one statement so a duplicate tag or serial anywhere rejects the
  // whole batch. A half-imported register is worse than none: you cannot tell
  // which rows are real without re-reading the spreadsheet line by line.
  const { error } = await supabase.from('assets').insert(rows);

  revalidatePath('/assets');
  if (error) {
    redirect(
      '/import?error=' +
        encodeURIComponent(
          `${error.message} — nothing was imported. Fix the row and paste again.`
        )
    );
  }
  redirect(`/assets?imported=${rows.length}`);
}
