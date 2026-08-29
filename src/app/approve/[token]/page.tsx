import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import '../../globals.css';

export const dynamic = 'force-dynamic';

/**
 * The page an email approver lands on. No account, no password, no session.
 *
 * THE MOST IMPORTANT THING ABOUT THIS FILE: opening it decides nothing.
 *
 * Mail servers, spam filters, link scanners and preview generators fetch URLs
 * out of messages without a human involved — Microsoft Defender and Gmail both
 * do it. If the emailed link approved on GET, a scanner would approve a
 * two-million-naira purchase order somewhere between our sending server and
 * the approver's inbox, and the audit log would say the approver did it.
 *
 * So this page only ever READS. app.resolve_approval_task() is read-only and
 * safe to call a hundred times. The decision is a POST that a person makes by
 * pressing a button on this page, and the confirmation step is the feature
 * rather than friction.
 */
const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'app' }, auth: { persistSession: false } },
  );

const naira = (minor?: number | null) =>
  minor == null ? null : '₦' + (Number(minor) / 100).toLocaleString('en-NG');

async function decide(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  const approve = String(formData.get('decision') ?? '') === 'approve';
  const note = String(formData.get('note') ?? '');

  const { data, error } = await anon().rpc('decide_by_token', {
    p_token: token,
    p_approve: approve,
    p_note: note || null,
  });

  revalidatePath(`/approve/${token}`);
  if (error) redirect(`/a/${token}?error=${encodeURIComponent(error.message)}`);

  const state = (data as any)?.state ?? 'done';
  redirect(`/a/${token}?done=${encodeURIComponent(state)}`);
}

export default async function Approve({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { done?: string; error?: string };
}) {
  const { data } = await anon().rpc('resolve_approval_task', { p_token: params.token });
  const t = (data ?? { state: 'invalid' }) as Record<string, any>;

  // Reuses the app's own card and button classes rather than inventing a
  // parallel set. This page is seen by people who see nothing else of the
  // product, so it should look like it belongs to it.
  const shell = (title: string, body: React.ReactNode) => (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '32px 18px 64px' }}>
      <div style={{
        fontSize: 12.5, fontWeight: 700, letterSpacing: '.05em',
        textTransform: 'uppercase', color: 'var(--brand)', marginBottom: 18,
      }}>
        Nothing Missing
      </div>
      <div className="card">
        <div className="card-h bd"><div><div className="card-t">{title}</div></div></div>
        <div style={{ padding: 20 }}>{body}</div>
      </div>
    </main>
  );

  if (t.state === 'invalid') {
    return shell(
      'This link is not valid',
      <p className="card-s">
        It may have been mistyped, or the approval it belonged to has been removed. Ask
        whoever sent it to issue a new one — they can do that from the request.
      </p>,
    );
  }

  if (t.state === 'expired') {
    return shell(
      'This link has expired',
      <p className="card-s">
        Approval links last thirty days. The request may still be waiting — ask for a fresh
        link and it will be reissued.
      </p>,
    );
  }

  if (t.state === 'decided' || searchParams.done) {
    const decided = searchParams.done ?? t.decision;
    const rejected = decided === 'rejected';
    return shell(
      rejected ? 'Recorded as declined' : 'Recorded as approved',
      <>
        <p className="card-s">
          Thank you{t.approver ? `, ${t.approver}` : ''}. Your decision on{' '}
          <b>{t.reference}</b>
          {t.title ? ` — ${t.title}` : ''} has been recorded against {t.company}&rsquo;s
          register, with your name and the time against it.
        </p>
        <p className="card-s" style={{ marginTop: 14 }}>
          This link will not work again. You can close this page.
        </p>
      </>,
    );
  }

  // state === 'open'
  const amount = naira(t.amount_minor);
  return shell(
    'An approval needs you',
    <>
      <p className="card-s">
        {t.approver}, {t.company} has asked you to approve the following. Nothing has
        happened yet — opening this page decides nothing.
      </p>

      {searchParams.error && (
        <div className="notice bad" style={{ marginTop: 16 }}>
          <p>{searchParams.error}</p>
        </div>
      )}

      <div className="tbl-wrap" style={{ margin: '18px 0' }}>
        <table>
          <tbody>
            <tr><td style={{ color: 'var(--text-3)' }}>Reference</td>
                <td className="mono">{t.reference}</td></tr>
            <tr><td style={{ color: 'var(--text-3)' }}>What</td><td>{t.title}</td></tr>
            <tr><td style={{ color: 'var(--text-3)' }}>Kind</td>
                <td style={{ textTransform: 'capitalize' }}>{t.kind}</td></tr>
            {amount && (
              <tr><td style={{ color: 'var(--text-3)' }}>Amount</td>
                  <td className="mono"><b style={{ fontSize: 15 }}>{amount}</b></td></tr>
            )}
            {t.location && (
              <tr><td style={{ color: 'var(--text-3)' }}>Location</td><td>{t.location}</td></tr>
            )}
            {t.detail && (
              <tr><td style={{ color: 'var(--text-3)' }}>Detail</td><td>{t.detail}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <form action={decide} style={{ display: 'grid', gap: 10 }}>
        <input type="hidden" name="token" value={params.token} />
        <label className="lbl" htmlFor="note">A note, if you want one</label>
        <textarea className="inp" id="note" name="note" rows={2}
                  placeholder="Optional — it goes in the log beside your name" />

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <button className="btn btn-p" type="submit" name="decision" value="approve">
            Approve
          </button>
          <button className="btn btn-g" type="submit" name="decision" value="reject"
                  style={{ color: 'var(--bad)' }}>
            Decline
          </button>
        </div>
        <p className="hint">
          Declining ends the request whatever anyone else says, so nobody has to chase a
          decision you have already made.
        </p>
      </form>
    </>,
  );
}
