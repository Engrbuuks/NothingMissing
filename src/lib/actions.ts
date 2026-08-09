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
