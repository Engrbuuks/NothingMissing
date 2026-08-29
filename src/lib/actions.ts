'use server';

import { parseSheet } from './sheet';
import { reportError } from './report-error';
import { announce, notify } from './notify';

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

  // Tell the destination. A consignment nobody is expecting is a consignment
  // that sits on a lorry, and this is the event the whole product exists for.
  const { data: t } = await supabase
    .from('transfers')
    .select('company_id, reference, waybill_no, to:to_location ( name ), from:from_location ( name ), transfer_lines ( count )')
    .eq('id', id)
    .maybeSingle();

  if (t) {
    const tr = t as any;
    await announce({
      companyId: tr.company_id,
      event: 'transfer.dispatched',
      subject: `${tr.waybill_no ?? tr.reference} is on its way to ${tr.to?.name ?? 'you'}`,
      body: `${tr.transfer_lines?.[0]?.count ?? 0} asset(s) left ${tr.from?.name ?? 'the origin'} `
          + `and are now in transit. Nothing joins your register until somebody at the `
          + `destination confirms what physically arrived.`,
    });
  }

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
  const supabase = sb();

  const { error } = await supabase.rpc('accept_transfer', {
    p_transfer: id,
    p_flagged: flagged,
    p_notes: notes || null,
  });

  // Anything short became a discrepancy with an owner and a clock. This is
  // the one event a company cannot switch off, because silencing it is how a
  // company discovers its own losses months later.
  if (flagged.length > 0) {
    const { data: t } = await supabase
      .from('transfers')
      .select('company_id, reference, waybill_no, to:to_location ( name )')
      .eq('id', id).maybeSingle();
    if (t) {
      const tr = t as any;
      await announce({
        companyId: tr.company_id,
        event: 'discrepancy.opened',
        subject: `${flagged.length} item(s) short on ${tr.waybill_no ?? tr.reference}`,
        body: `Received at ${tr.to?.name ?? 'the destination'} with ${flagged.length} `
            + `line(s) flagged. Each is now an open discrepancy with somebody's name `
            + `against it and a clock running.`,
      });
    }
  }

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

/**
 * Stock becoming assets.
 *
 * The transition a register needs and did not have: fifty chairs sit in the
 * store as a countable balance, twelve are issued to a branch where somebody
 * signs for them, and from that moment somebody will ask where a specific one
 * is. Issuing alone destroyed the quantity and created nothing, so the twelve
 * left the ledger and arrived nowhere.
 *
 * All the rules — the balance check, the refusal to tag a divisible item, the
 * serial count — live in app.commission_stock(), which does the deduction and
 * the creation in one transaction.
 */
export async function commissionStock(formData: FormData): Promise<void> {
  const raw = String(formData.get('serials') ?? '').trim();
  // One per line or comma-separated, because people paste from a delivery note.
  const serials = raw
    ? raw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)
    : null;

  const { data, error } = await sb().rpc('commission_stock', {
    p_item: String(formData.get('item')),
    p_location: String(formData.get('location')),
    p_qty: Number(formData.get('qty')),
    p_name: (formData.get('name') as string) || null,
    p_model: (formData.get('model') as string) || null,
    p_holder: (formData.get('holder') as string) || null,
    p_serials: serials,
    p_note: (formData.get('reason') as string) || null,
  });

  revalidatePath('/inventory');
  revalidatePath('/assets');
  if (error) redirect(`/inventory?error=${encodeURIComponent(error.message)}`);
  redirect(`/assets?added=${(data as any)?.created ?? 1}`);
}

/**
 * An asset going back to the store, becoming interchangeable again.
 *
 * The asset is retired rather than deleted: who held it and what was spent on
 * it is the company's record, and does not stop being true because the thing
 * went back on a shelf.
 */
export async function returnAssetToStock(formData: FormData): Promise<void> {
  const asset = String(formData.get('asset') ?? '');
  const { error } = await sb().rpc('return_to_stock', {
    p_asset: asset,
    p_item: String(formData.get('item')),
    p_reason: (formData.get('reason') as string) || null,
  });
  revalidatePath('/inventory');
  revalidatePath('/assets');
  revalidatePath(`/assets/${asset}`);
  if (error) redirect(`/assets/${asset}?error=${encodeURIComponent(error.message)}`);
  redirect(`/assets/${asset}?returned=1`);
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
  const supabase = sb();
  const { error } = await supabase.rpc('decide_request', {
    p_request: id,
    p_approve: String(formData.get('decision')) === 'approve',
    p_note: (formData.get('note') as string) || null,
  });

  // Whichever way it went, somebody is waiting to hear. If a step was
  // approved and the chain continues, request_notice() reports the NEXT step
  // as pending, so this asks the next approver rather than announcing an
  // outcome that has not happened yet.
  if (!error) await tellApprovers(supabase, id, 'request.decided');

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
  const { data: raised, error } = await supabase.rpc('raise_request', {
    p_company: loc.company_id,
    p_kind: kind,
    p_title: String(formData.get('title') ?? ''),
    p_detail: String(formData.get('detail') ?? '') || null,
    p_location: location,
    p_asset: String(formData.get('asset') ?? '') || null,
    p_amount: amountRaw ? Number(amountRaw) * 100 : null,
    p_items: Number(formData.get('items') ?? 1) || 1,
  });

  // Tell whoever has to sign it. An approval chain nobody is told about is a
  // queue people discover by logging in and looking, which is how a request
  // for a broken generator waits three days on somebody's screen.
  if (!error && raised) {
    await tellApprovers(supabase, String(raised), 'request.raised');
    // Email approvers, who have no account and so appear on no role list.
    await sendApprovalLinks(supabase, String(raised));
  }

  revalidatePath('/requests');
  if (error) redirect('/requests/new?error=' + encodeURIComponent(error.message));
  redirect('/requests?raised=1');
}

/**
 * Email the people who can act on a request, and the person who raised it.
 *
 * The audience comes from app.request_notice() rather than from a role list
 * written here: `decide_request()` decides which role a step needs and
 * seniority satisfies a junior step, so working the audience out separately
 * would be a second opinion that could quietly disagree with the first.
 */
/**
 * Send the email approvers their links.
 *
 * The tokens come back exactly once from app.claim_approval_tokens() — only
 * hashes are stored — so anything that fails here is recovered by reissuing
 * from the request page, not by reading the token again.
 */
async function sendApprovalLinks(
  supabase: ReturnType<typeof sb>,
  requestId: string,
): Promise<void> {
  try {
    const { data: tasks } = await supabase.rpc('claim_approval_tokens', {
      p_request: requestId,
    });
    const list = (tasks ?? []) as { name: string; email: string; token: string }[];
    if (!list.length) return;

    const { data: n } = await supabase.rpc('request_notice', { p_request: requestId });
    const notice = (n ?? {}) as Record<string, any>;
    const money = notice.amount_minor
      ? `\nAmount: ₦${(Number(notice.amount_minor) / 100).toLocaleString('en-NG')}`
      : '';
    const where = notice.location ? `\nLocation: ${notice.location}` : '';

    const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';

    for (const task of list) {
      // The apex, not the tenant subdomain. An approver has no account and no
      // business being sent to a company's application host, and the apex is
      // where /a/<token> is routed from.
      const link = `https://${root}/a/${task.token}`;

      await notify({
        companyId: String(notice.company_id ?? ''),
        event: 'request.raised',
        channel: 'email',
        recipient: task.email,
        subject: `Approval needed: ${notice.reference} — ${notice.title}`,
        body:
          `${task.name},\n\n` +
          `${notice.raised_by ?? 'Somebody'} has raised a ${notice.kind} request that needs ` +
          `your approval.\n\n` +
          `${notice.reference} — ${notice.title}${money}${where}\n` +
          (notice.detail ? `\n${notice.detail}\n` : '') +
          `\nOpen this link to see it and decide:\n${link}\n\n` +
          `Opening the link does not approve anything — it shows you the request and you ` +
          `press Approve or Decline there. The link works once and expires in 30 days.`,
      });
    }
  } catch {
    /* a raised request must not appear to fail because email did */
  }
}

async function tellApprovers(
  supabase: ReturnType<typeof sb>,
  requestId: string,
  event: 'request.raised' | 'request.decided',
): Promise<void> {
  try {
    const { data: n } = await supabase.rpc('request_notice', { p_request: requestId });
    if (!n) return;

    const notice = n as Record<string, any>;
    const money = notice.amount_minor
      ? `\nAmount: ₦${(Number(notice.amount_minor) / 100).toLocaleString('en-NG')}`
      : '';
    const where = notice.location ? `\nLocation: ${notice.location}` : '';
    const about = notice.asset ? `\nAsset: ${notice.asset}` : '';
    const detail = notice.detail ? `\n\n${notice.detail}` : '';
    const line = `${notice.reference} — ${notice.title}`;

    if (notice.status === 'pending') {
      const roles: string[] = Array.isArray(notice.notify_roles) ? notice.notify_roles : [];
      // A chain still running: ask the step that is waiting. The subject says
      // what is wanted, because an approver scanning a phone decides from the
      // subject whether to open it at all.
      await announce({
        companyId: notice.company_id,
        event,
        roles,
        subject: `Approval needed: ${line}`,
        body:
          `${notice.raised_by ?? 'Somebody'} raised a ${notice.kind} request that needs your approval.\n\n` +
          `${line}${money}${where}${about}${detail}\n\n` +
          `This is step ${notice.step} of ${notice.of}, waiting on a ${notice.awaiting_role}.\n\n` +
          `Open Requests in Nothing Missing to approve or decline it.`,
      });
      return;
    }

    // Finished, one way or the other. Only the raiser needs this — the
    // approvers were there when it happened.
    const outcome = notice.status === 'approved' ? 'approved' : String(notice.status);
    await announce({
      companyId: notice.company_id,
      event: 'request.decided',
      roles: [],
      also: [notice.raised_by_email],
      subject: `Your request was ${outcome}: ${line}`,
      body:
        `The ${notice.kind} request you raised has been ${outcome}.\n\n` +
        `${line}${money}${where}${about}\n\n` +
        `Open Requests in Nothing Missing to see who decided and any note they left.`,
    });
  } catch {
    /* a request that was raised must not appear to fail because email did */
  }
}

export async function updateCompany(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  const supabase = sb();

  // The NAME goes through app.rename_company(), not this update. That function
  // restricts the change to an owner or admin, refuses a one-character name,
  // and writes an audit row recording what it used to be called. Writing the
  // column directly here skipped all three — so a company could be renamed
  // with nothing in the log saying it had been, which for the name printed on
  // every waybill is exactly the change you would want to be able to trace.
  //
  // Same lesson as the brand colour: two forms owning one field means one of
  // them silently wins.
  const name = String(formData.get('name') ?? '').trim();
  if (name) {
    const { error: nameError } = await supabase.rpc('rename_company', {
      p_company: id,
      p_name: name,
    });
    if (nameError) {
      redirect('/settings?error=' + encodeURIComponent(nameError.message));
    }
  }

  const { error } = await supabase
    .from('companies')
    .update({
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
  // The name is on every page's chrome, so the whole layout re-renders.
  revalidatePath('/', 'layout');
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

  const name = String(formData.get('name') ?? '').trim();
  if (!name) {
    redirect('/assets/new?error=' + encodeURIComponent('An asset needs a name.'));
  }

  // Location is optional at the form. The database requires one for anything
  // not in transit, so an asset entered without one lands in the virtual
  // warehouse — which is exactly what that location is for. Refusing the entry
  // instead means a register nobody finishes building, and an asset recorded
  // in the wrong place is far easier to correct than one never recorded.
  let location = String(formData.get('location') ?? '').trim();
  let companyId: string | null = null;

  if (location) {
    const { data: loc } = await supabase
      .from('locations').select('company_id').eq('id', location).maybeSingle();
    if (!loc) {
      redirect('/assets/new?error=' + encodeURIComponent('That location could not be read.'));
    }
    companyId = loc.company_id;
  } else {
    const { data: warehouse } = await supabase
      .from('locations')
      .select('id, company_id')
      .eq('kind', 'virtual')
      .is('archived_at', null)
      .limit(1)
      .maybeSingle();
    if (!warehouse) {
      redirect('/assets/new?error=' + encodeURIComponent(
        'Choose a location — this company has no virtual warehouse to fall back on.'));
    }
    location = warehouse.id;
    companyId = warehouse.company_id;
  }

  const cost = String(formData.get('cost') ?? '').replace(/[^\d]/g, '');
  const model = String(formData.get('model') ?? '');

  // Quantity creates that many assets, each individually tagged. It is not a
  // column: an asset row holds one location, one serial and one history, so a
  // row reading "10 chairs" stops being true the moment three of them move.
  // Ten rows can each move, be repaired and be disposed of separately, which
  // is the entire reason this is a register rather than a stock list.
  const quantity = Math.floor(Number(formData.get('quantity') ?? 1));
  if (!Number.isFinite(quantity) || quantity < 1) {
    redirect('/assets/new?error=' + encodeURIComponent('Quantity must be at least 1.'));
  }
  // A ceiling, because 500 rows typed into a form is a spreadsheet, and the
  // import handles those better — with a dry run, which this has no way to do.
  if (quantity > 100) {
    redirect('/assets/new?error=' + encodeURIComponent(
      'That is more than 100 — use Import for a batch that size, so you can preview it first.'));
  }

  const serial = String(formData.get('serial') ?? '').trim();
  const tag = String(formData.get('tag') ?? '').trim();

  // One serial cannot describe ten machines, and one tag cannot label them.
  // The unique constraint would refuse the second row anyway; saying so here
  // means the person is told which field to fix rather than reading a
  // constraint name.
  if (quantity > 1 && serial) {
    redirect('/assets/new?error=' + encodeURIComponent(
      'A serial number identifies one machine. Add these without serials and fill each in later, or enter them one at a time.'));
  }
  if (quantity > 1 && tag) {
    redirect('/assets/new?error=' + encodeURIComponent(
      'A tag labels one asset. Leave the tag blank and each of the ' + quantity + ' will be issued its own.'));
  }

  // Tag and serial go in as typed. A blank tag is filled by the database
  // trigger from app.next_asset_tag(), and a blank serial becomes null there
  // too — doing either here would mean the form and the spreadsheet import
  // could drift apart, which is exactly how the two paths disagreed before.
  // The type, for assets with no catalog model. Sent regardless; the database
  // trigger clears it when a model is attached, so the model always wins and
  // the two can never disagree about what kind of thing this is.
  const subCategory = String(formData.get('sub_category') ?? '').trim() || null;

  const common = {
    company_id: companyId,
    name,
    sub_category_id: subCategory,
    description: String(formData.get('description') ?? '').trim() || null,
    model_id: model || null,
    location_id: location,
    status: 'active',
    holder: String(formData.get('holder') ?? '').trim() || null,
    acquired_on: String(formData.get('acquired') ?? '') || null,
    meter_value: Number(formData.get('meter') ?? 0) || 0,
    meter_unit: String(formData.get('meter_unit') ?? '') || null,
  };

  // One statement, so the batch is all or nothing. Five of ten landing leaves
  // somebody counting rows to work out which five to enter again.
  const { data: created, error } = await supabase
    .from('assets')
    .insert(
      Array.from({ length: quantity }, () => ({
        ...common,
        tag,
        serial_no: serial || null,
      })),
    )
    .select('id');

  const asset = created?.[0];

  if (error || !asset) {
    redirect('/assets/new?error=' + encodeURIComponent(error?.message ?? 'Could not add the asset.'));
  }

  // Cost goes in its own table, so an asset added by someone who cannot see
  // costs simply has no financial row rather than a zero.
  //
  // The figure is the cost of ONE, written against each unit — not the invoice
  // total split between them. Ten chairs on a ₦450,000 invoice are ₦45,000
  // each, and depreciation, disposal and book value are all per asset, so a
  // total stored ten times would overstate the estate tenfold.
  if (cost) {
    await supabase.from('asset_financials').insert(
      (created ?? []).map((a) => ({
        asset_id: a.id,
        company_id: companyId,
        purchase_cost_minor: Number(cost) * 100,
        invoice_ref: String(formData.get('invoice') ?? '') || null,
      })),
    );
  }

  revalidatePath('/assets');

  // One asset opens on its own page, because there is something to look at.
  // A batch goes to the register, where all of them are visible at once.
  if (quantity === 1) redirect(`/assets/${asset.id}?added=1`);
  redirect(`/assets?added=${quantity}`);
}

/**
 * Set or clear the type of an asset that has no catalog model.
 *
 * An asset reaches its category through the catalog when it is catalogued.
 * When it is not — and that is now the ordinary case, since a model is
 * optional — this is the only way it gets one, and without it the register
 * fills with things nobody can group, filter or report on.
 */
export async function classifyAsset(formData: FormData): Promise<void> {
  const asset = String(formData.get('asset') ?? '');
  const { error } = await sb().rpc('classify_asset', {
    p_asset: asset,
    p_sub_category: String(formData.get('sub_category') ?? '') || null,
  });
  revalidatePath(`/assets/${asset}`);
  revalidatePath('/assets');
  if (error) redirect(`/assets/${asset}?error=${encodeURIComponent(error.message)}`);
  redirect(`/assets/${asset}?saved=1`);
}

/* -------------------------------------------------------------------------- *
 * Renaming catalog entries.
 *
 * Every level could be created and deleted and none could be corrected, so a
 * typo was permanent unless the entry happened to be unused — and a category
 * in use cannot be deleted, which is exactly the one you notice the typo on,
 * because you noticed it while looking at the assets under it.
 *
 * A rename is safe in a way a delete is not. Everything points at these rows
 * by id, so correcting the text changes what is displayed and breaks no
 * reference: assets keep their category, models keep their type, and the
 * audit rows already written keep the name they were written with, which is
 * correct — the log records what a thing was called at the time.
 * -------------------------------------------------------------------------- */

/** Shared by all four: same shape, same failure modes, one place to fix them. */
async function renameCatalogRow(
  table: 'categories' | 'sub_categories' | 'brands' | 'models',
  id: string,
  raw: string,
): Promise<never> {
  const name = raw.trim();

  if (!id) redirect('/catalog?error=' + encodeURIComponent('Nothing to rename.'));
  if (!name) {
    redirect('/catalog?error=' + encodeURIComponent('A name cannot be blank.'));
  }

  const { error } = await sb().from(table).update({ name }).eq('id', id);

  revalidatePath('/catalog');
  // Everything downstream displays this name, so it all has to re-render.
  revalidatePath('/assets');
  revalidatePath('/dashboard');
  revalidatePath('/inventory');

  if (error) {
    // The unique constraint is the likely failure, and its raw message names
    // an index rather than the problem.
    const duplicate = error.code === '23505' || /duplicate|unique/i.test(error.message);
    redirect('/catalog?error=' + encodeURIComponent(
      duplicate
        ? `Another entry is already called "${name}". Names have to be distinct so a list can be read.`
        : error.message,
    ));
  }
  redirect('/catalog?renamed=' + encodeURIComponent(name));
}

export async function renameCategory(id: string, formData: FormData): Promise<void> {
  await renameCatalogRow('categories', id, String(formData.get('name') ?? ''));
}

export async function renameSubCategory(id: string, formData: FormData): Promise<void> {
  await renameCatalogRow('sub_categories', id, String(formData.get('name') ?? ''));
}

export async function renameBrand(id: string, formData: FormData): Promise<void> {
  await renameCatalogRow('brands', id, String(formData.get('name') ?? ''));
}

export async function renameModel(id: string, formData: FormData): Promise<void> {
  await renameCatalogRow('models', id, String(formData.get('name') ?? ''));
}

/* -------------------------------------------------------------------------- *
 * Email approvers — people who sign things off without holding an account.
 * -------------------------------------------------------------------------- */

export async function saveExternalApprover(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/approvals?error=' + encodeURIComponent('No company in scope.'));

  // The checkbox matrix. getAll, because an unticked box sends nothing at all
  // and the database replaces the whole set — merging would make it impossible
  // to take somebody off a process.
  const types = formData.getAll('types').map(String).filter(Boolean);

  const { error } = await supabase.rpc('save_external_approver', {
    p_company: co.id,
    p_name: String(formData.get('name') ?? ''),
    p_email: String(formData.get('email') ?? ''),
    p_types: types,
    p_approver: String(formData.get('approver') ?? '') || null,
  });

  revalidatePath('/approvals');
  if (error) redirect('/approvals?error=' + encodeURIComponent(error.message));
  redirect('/approvals?saved=1');
}

export async function removeExternalApprover(id: string): Promise<void> {
  const { error } = await sb().rpc('remove_external_approver', { p_approver: id });
  revalidatePath('/approvals');
  if (error) redirect('/approvals?error=' + encodeURIComponent(error.message));
  redirect('/approvals?removed=1');
}

export async function setExternalQuorum(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/approvals?error=' + encodeURIComponent('No company in scope.'));

  const { error } = await supabase.rpc('set_external_quorum', {
    p_company: co.id,
    p_type: String(formData.get('request_type') ?? ''),
    p_mode: String(formData.get('mode') ?? 'any'),
  });
  revalidatePath('/approvals');
  if (error) redirect('/approvals?error=' + encodeURIComponent(error.message));
  redirect('/approvals?saved=1');
}

/** A fresh link when the first never arrived. The old one stops working. */
export async function resendApprovalLink(taskId: string): Promise<void> {
  const supabase = sb();
  const { data, error } = await supabase.rpc('resend_approval_task', { p_task: taskId });

  if (!error && data) {
    const d = data as Record<string, any>;
    const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';
    const money = d.amount_minor
      ? `\nAmount: ₦${(Number(d.amount_minor) / 100).toLocaleString('en-NG')}`
      : '';
    const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
    await notify({
      companyId: String(co?.id ?? ''),
      event: 'request.raised',
      channel: 'email',
      recipient: String(d.email),
      subject: `Reminder — approval needed: ${d.reference} ${d.title}`,
      body:
        `${d.name},\n\nA new link for the ${d.kind} request still waiting on you.\n\n` +
        `${d.reference} — ${d.title}${money}\n\n` +
        `https://${root}/a/${d.token}\n\n` +
        `Any earlier link for this request has stopped working.`,
    });
  }

  revalidatePath('/requests');
  if (error) redirect('/requests?error=' + encodeURIComponent(error.message));
  redirect('/requests?resent=1');
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

/**
 * Inviting somebody to sign in.
 *
 * The old version created an invitation row and handed the link back to the
 * inviter to copy and send themselves. That is not an invitation system — it
 * is a token generator with homework, and it meant nobody was ever invited.
 *
 * Now the email is sent. Two paths, because the right one depends on whether
 * the person already has an account:
 *
 *   * NO ACCOUNT — Supabase's admin invite creates the user and emails a link
 *     that sets their password. They never see a sign-up page, which is what
 *     made the old flow look like company registration.
 *
 *   * ALREADY HAS AN ACCOUNT — a colleague at another company, or somebody
 *     re-invited. Supabase would refuse to create them again, so we send our
 *     own email with the join link instead.
 *
 * If neither can send, the link is still shown. A missing key should slow
 * somebody down, not stop them.
 */
export async function inviteMember(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase
    .from('companies').select('id, name').limit(1).maybeSingle();
  if (!co) redirect('/people?error=' + encodeURIComponent('No company in scope.'));

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const role = String(formData.get('role') ?? 'requester');

  // The invitation row carries the role and location. It is the record of who
  // was invited to what, and it is what the person accepts against.
  const { data, error } = await supabase.rpc('invite_member', {
    p_company: (co as any).id,
    p_email: email,
    p_role: role,
    p_location: String(formData.get('location') ?? '') || null,
  });

  revalidatePath('/people');
  if (error) redirect('/people?error=' + encodeURIComponent(error.message));

  const path = (data as any)?.path ?? '';
  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';
  const joinUrl = `https://${root}${path}`;
  const company = (co as any).name as string;

  const sent = await sendInvitationEmail({ email, role, company, joinUrl, root });

  redirect(sent
    ? `/people?invited=${encodeURIComponent(email)}`
    // Only when nothing could send. The link is the fallback, not the plan.
    : `/people?invite=${encodeURIComponent(path)}`);
}

/**
 * Sends the invitation. Returns false only if every route failed, so the
 * caller can fall back to showing the link.
 */
async function sendInvitationEmail(m: {
  email: string; role: string; company: string; joinUrl: string; root: string;
}): Promise<boolean> {
  const { adminConfigured, adminAuth } = await import('./admin');

  // Path one: they have no account. Supabase creates the user and emails a
  // link that sets a password — no sign-up page, no chance of them thinking
  // they are registering a company.
  if (adminConfigured()) {
    try {
      const { error } = await adminAuth().auth.admin.inviteUserByEmail(m.email, {
        redirectTo: `https://${m.root}/auth/callback`,
        data: { invited_to: m.company, invited_as: m.role },
      });
      if (!error) return true;

      // "already been registered" is expected for an existing user, and is
      // not a failure — it just means the other path applies.
      if (!/already|registered|exists/i.test(error.message)) {
        reportError(error, { route: 'invite-admin' });
      }
    } catch (e) {
      reportError(e, { route: 'invite-admin' });
    }
  }

  // Path two: they already have an account, so they need the join link rather
  // than a password-setting one.
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.NOTIFY_FROM ?? `Nothing Missing <no-reply@${m.root}>`,
          to: [m.email],
          subject: `${m.company} has invited you`,
          html: invitationHtml(m),
        }),
      });
      if (res.ok) return true;
      reportError(new Error(`Resend returned ${res.status}`), { route: 'invite-resend' });
    } catch (e) {
      reportError(e, { route: 'invite-resend' });
    }
  }

  return false;
}

function invitationHtml(m: { company: string; role: string; joinUrl: string }) {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  return `<!doctype html><html><body style="margin:0;background:#F4F6FB;padding:28px 16px;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#061F3E">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#fff;
      border-radius:16px;padding:30px" cellpadding="0" cellspacing="0">
      <tr><td style="font-size:12px;font-weight:700;color:#0551BD;letter-spacing:.08em;
        text-transform:uppercase;padding-bottom:16px">Nothing Missing</td></tr>
      <tr><td style="font-size:20px;font-weight:700;letter-spacing:-.02em;padding-bottom:12px">
        ${esc(m.company)} has invited you</td></tr>
      <tr><td style="font-size:14.5px;line-height:1.62;color:#5F6379;padding-bottom:22px">
        You have been invited to join their asset register as
        <b>${esc(m.role)}</b>. Opening the link below adds you to their company —
        it does not create one of your own.</td></tr>
      <tr><td style="padding-bottom:22px">
        <a href="${m.joinUrl}" style="display:inline-block;background:#0551BD;color:#fff;
          text-decoration:none;padding:12px 22px;border-radius:10px;font-size:14.5px;
          font-weight:600">Accept the invitation</a></td></tr>
      <tr><td style="font-size:12px;color:#9296AC;line-height:1.55">
        The link expires in 14 days and only opens for this email address, so
        forwarding it will not let anybody else in.<br><br>
        If you were not expecting this, ignore it — nothing happens until you
        open the link.</td></tr>
    </table>
  </td></tr></table></body></html>`;
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


export async function resendInvitation(id: string): Promise<void> {
  const supabase = sb();
  const { data, error } = await supabase.rpc('resend_invitation', { p_id: id });
  revalidatePath('/people');
  if (error) redirect(`/people?error=${encodeURIComponent(error.message)}`);

  const { data: co } = await supabase
    .from('companies').select('name').limit(1).maybeSingle();
  const { data: inv } = await supabase
    .from('invitations').select('email, role').eq('id', id).maybeSingle();

  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';
  const path = (data as any)?.path ?? '';

  const sent = await sendInvitationEmail({
    email: (inv as any)?.email ?? '',
    role: (inv as any)?.role ?? 'member',
    company: (co as any)?.name ?? 'A company',
    joinUrl: `https://${root}${path}`,
    root,
  });

  redirect(sent
    ? `/people?invited=${encodeURIComponent((inv as any)?.email ?? '')}`
    : `/people?invite=${encodeURIComponent(path)}`);
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

/**
 * Raising a purchase order.
 *
 * The lines come from a repeating form, so they arrive as parallel arrays —
 * every description, then every quantity. Zipping them here keeps the database
 * function taking a clean structure rather than parsing form encoding.
 */
export async function raisePurchaseOrder(formData: FormData): Promise<void> {
  const descriptions = formData.getAll('description').map(String);
  const quantities = formData.getAll('qty').map(String);
  const costs = formData.getAll('unit_cost').map(String);
  const models = formData.getAll('model').map(String);
  const items = formData.getAll('stock_item').map(String);

  const lines = descriptions
    .map((description, i) => ({
      description,
      qty: Number(quantities[i] ?? 0),
      unit_cost: costs[i] ?? '',
      model_id: models[i] || null,
      stock_item_id: items[i] || null,
    }))
    .filter((l) => l.qty > 0 && (l.description.trim() || l.model_id || l.stock_item_id));

  if (!lines.length) {
    redirect('/purchase-orders/new?error=' + encodeURIComponent(
      'Add at least one line with a quantity above zero.'));
  }

  const { data, error } = await sb().rpc('raise_purchase_order', {
    p_supplier: String(formData.get('supplier') ?? '') || null,
    p_destination: String(formData.get('destination') ?? ''),
    p_lines: lines,
    p_expected_on: String(formData.get('expected') ?? '') || null,
    p_notes: String(formData.get('notes') ?? '') || null,
  });

  revalidatePath('/purchase-orders');
  if (error) redirect('/purchase-orders/new?error=' + encodeURIComponent(error.message));
  redirect(`/purchase-orders?raised=${encodeURIComponent((data as any)?.reference ?? '')}`);
}

export async function issuePurchaseOrder(id: string): Promise<void> {
  const { error } = await sb().rpc('issue_purchase_order', { p_id: id });
  revalidatePath('/purchase-orders');
  redirect(error
    ? `/purchase-orders?error=${encodeURIComponent(error.message)}`
    : '/purchase-orders?issued=1');
}

export async function cancelPurchaseOrder(formData: FormData): Promise<void> {
  const { error } = await sb().rpc('cancel_purchase_order', {
    p_id: String(formData.get('id') ?? ''),
    p_reason: String(formData.get('reason') ?? ''),
  });
  revalidatePath('/purchase-orders');
  redirect(error
    ? `/purchase-orders?error=${encodeURIComponent(error.message)}`
    : '/purchase-orders?cancelled=1');
}

export async function saveApprovalPolicy(formData: FormData): Promise<void> {
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/approvals?error=' + encodeURIComponent('No company in scope.'));

  const naira = (k: string) => {
    const v = String(formData.get(k) ?? '').replace(/[^\d]/g, '');
    return v ? Number(v) * 100 : null;
  };

  const { error } = await supabase.rpc('set_approval_policy', {
    p_company: co.id,
    p_type: String(formData.get('type') ?? 'purchase'),
    p_name: String(formData.get('name') ?? ''),
    p_chain: formData.getAll('chain').map(String).filter(Boolean),
    p_min_amount: naira('min_amount'),
    p_max_amount: naira('max_amount'),
    p_min_items: Number(formData.get('min_items') ?? 0) || null,
    p_max_items: Number(formData.get('max_items') ?? 0) || null,
    p_priority: Number(formData.get('priority') ?? 100),
    p_id: String(formData.get('id') ?? '') || null,
  });

  revalidatePath('/approvals');
  redirect(error ? `/approvals?error=${encodeURIComponent(error.message)}` : '/approvals?saved=1');
}

export async function deleteApprovalPolicy(id: string): Promise<void> {
  const { error } = await sb().rpc('delete_approval_policy', { p_id: id });
  revalidatePath('/approvals');
  redirect(error ? `/approvals?error=${encodeURIComponent(error.message)}` : '/approvals?removed=1');
}

/**
 * Logging maintenance on any asset.
 *
 * The maintenance page could only act on assets the system had already flagged
 * as due by interval — so a generator that broke unexpectedly had nowhere to
 * be recorded. Machines do not break on schedule, which is most of the point of
 * tracking them.
 */
export async function logMaintenance(formData: FormData): Promise<void> {
  const asset = String(formData.get('asset') ?? '');
  const cost = String(formData.get('cost') ?? '').replace(/[^\d]/g, '');

  const { error } = await sb().rpc('log_service', {
    p_asset: asset,
    p_kind: String(formData.get('kind') ?? 'repair'),
    p_cost: cost ? Number(cost) * 100 : null,
    p_vendor: String(formData.get('vendor') ?? '') || null,
    p_note: String(formData.get('note') ?? '') || null,
  });

  revalidatePath('/maintenance');
  revalidatePath(`/assets/${asset}`);
  redirect(error
    ? `/maintenance/new?error=${encodeURIComponent(error.message)}`
    : '/maintenance?logged=1');
}

/**
 * Deleting somebody.
 *
 * Owner only, and the confirmation is typing their name — a dialogue somebody
 * clicks through is not a confirmation, and this is not undoable.
 *
 * Two halves: the database removes everything scoped to them, and if they
 * belong to no other company their Supabase login goes too. Without the second
 * half they would keep an account that can sign in and see nothing, which
 * looks like a bug to them and like a leak to you.
 */
export async function deletePerson(formData: FormData): Promise<void> {
  const supabase = sb();
  const userId = String(formData.get('user') ?? '');
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  if (!co) redirect('/people?error=' + encodeURIComponent('No company in scope.'));

  const { data, error } = await supabase.rpc('delete_person', {
    p_company: (co as any).id,
    p_user: userId,
    p_confirm: String(formData.get('confirm') ?? ''),
  });

  revalidatePath('/people');
  if (error) redirect(`/people?error=${encodeURIComponent(error.message)}`);

  const result = (data as any) ?? {};

  // Their login only goes if the database confirmed they belong nowhere else.
  // Somebody who works for two companies here must not lose their account
  // because one of them removed them.
  if (result.account_removed) {
    const { adminConfigured, adminAuth } = await import('./admin');
    if (adminConfigured()) {
      try {
        await adminAuth().auth.admin.deleteUser(userId);
      } catch (e) {
        // The company data is already gone, which is what was asked for. A
        // stranded auth user can sign in and see nothing, so it is worth
        // knowing about but not worth failing the whole action over.
        reportError(e, { route: 'delete-person', userId });
      }
    }
  }

  redirect(`/people?deleted=${encodeURIComponent(result.name ?? 'That person')}`);
}

export async function deleteInvitation(id: string): Promise<void> {
  const { data, error } = await sb().rpc('delete_invitation', { p_id: id });
  revalidatePath('/people');
  redirect(error
    ? `/people?error=${encodeURIComponent(error.message)}`
    : `/people?deleted=${encodeURIComponent((data as any)?.email ?? 'The invitation')}`);
}
