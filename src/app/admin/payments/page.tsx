import { redirect } from 'next/navigation';
import { sb, getSession, money } from '@/lib/session';
import { reviewPaymentProof, savePlatformSettings } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * The reviewer queue. Deliberately outside the tenant shell — this is not a
 * screen inside anyone's company, it is the vendor confirming payments.
 *
 * The only cross-tenant view in the product. It shows the company name, the
 * amount, the receipt and how many assets they hold — enough to check a
 * transfer, and nothing more. No register, no people, no audit trail.
 */
export default async function AdminPayments({
  searchParams,
}: { searchParams: { error?: string; done?: string; saved?: string } }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const supabase = sb();
  const { data: pending, error } = await supabase.rpc('pending_payment_proofs');

  // Not a reviewer: the function returns nothing rather than erroring, so
  // check membership explicitly to say something useful.
  const { data: me } = await supabase
    .from('platform_reviewers').select('user_id').maybeSingle();

  if (!me) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '80px 24px' }}>
        <h1 style={{ fontSize: 23 }}>Not a reviewer</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          This page is for confirming customer bank transfers, and your account is not on
          the reviewer list. There is deliberately no screen for adding someone — it is a
          database action, because a button that grants cross-tenant visibility is a button
          somebody eventually clicks by mistake.
        </p>
        <a className="btn btn-g" href="/" style={{ marginTop: 20 }}>Back</a>
      </main>
    );
  }

  const { data: bank } = await supabase
    .from('platform_settings')
    .select('bank_name, account_name, account_number, instructions')
    .maybeSingle();
  const bk = (bank ?? {}) as any;
  const rows = (pending ?? []) as any[];

  return (
    <main className="wrap" style={{ padding: '32px 24px 70px', maxWidth: 940 }}>
      <div style={{ marginBottom: 22 }}>
        <div className="pt">Payments awaiting confirmation</div>
        <div className="pt-sub">
          The one cross-tenant screen in the product — and it shows only what a transfer
          needs
        </div>
      </div>

      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.done && <div className="notice"><p>Recorded. The company&rsquo;s own audit log names you.</p></div>}
      {searchParams.saved && <div className="notice"><p>Bank details saved.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} awaiting</div>
            <div className="card-s">Oldest first. Check each against the account before confirming.</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>Nothing waiting</h4>
            <p>Transfers customers record appear here for confirmation.</p>
          </div>
        ) : (
          rows.map((p) => (
            <div key={p.id} style={{ padding: '20px', borderBottom: '1px solid var(--line-2)' }}>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div className="aname" style={{ fontSize: 15 }}>{p.company_name}</div>
                  <div className="amake">
                    <span className="tag">{p.company_slug}.nothingmissing.ng</span> · {p.assets} assets
                  </div>
                  <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', marginTop: 14 }}>
                    <div><span className="wb-lbl">Amount</span><b className="mono" style={{ display: 'block', fontSize: 16 }}>{money(p.amount_minor)}</b></div>
                    <div><span className="wb-lbl">Paid on</span><b style={{ display: 'block' }}>{p.paid_on}</b></div>
                    <div><span className="wb-lbl">From</span><b style={{ display: 'block' }}>{p.bank_used ?? '—'}</b></div>
                    <div><span className="wb-lbl">Sender</span><b style={{ display: 'block' }}>{p.sender_name ?? '—'}</b></div>
                  </div>
                  {p.narration && (
                    <p style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 10, fontStyle: 'italic' }}>
                      Narration: &ldquo;{p.narration}&rdquo;
                    </p>
                  )}
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10 }}>
                    Recorded by {p.submitted_label} · {new Date(p.submitted_at).toLocaleString('en-GB')}
                  </div>
                </div>

                <div style={{ flex: 'none' }}>
                  {p.receipt_path ? (
                    <a className="btn btn-g" href={`/admin/payments/receipt?path=${encodeURIComponent(p.receipt_path)}`}
                       target="_blank" rel="noreferrer">
                      View receipt
                    </a>
                  ) : (
                    <span className="pill p-warn"><span className="pd" />No receipt attached</span>
                  )}
                </div>
              </div>

              <form action={reviewPaymentProof} style={{ marginTop: 16, display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                <input type="hidden" name="id" value={p.id} />
                <input className="inp" name="note" placeholder="Note — what you checked, or why not"
                       style={{ flex: 1, minWidth: 220 }} />
                <button className="btn btn-p" type="submit" name="decision" value="approve">
                  Confirm {money(p.amount_minor)}
                </button>
                <button className="btn btn-g" type="submit" name="decision" value="reject"
                        style={{ color: 'var(--bad)' }}>
                  Not found
                </button>
              </form>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">The account customers pay into</div>
            <div className="card-s">Shown on every company&rsquo;s transfer page</div>
          </div>
        </div>
        <form action={savePlatformSettings} style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="bank">Bank</label>
              <input className="inp" id="bank" name="bank" defaultValue={bk.bank_name ?? ''} />
            </div>
            <div>
              <label className="lbl" htmlFor="account_name">Account name</label>
              <input className="inp" id="account_name" name="account_name" defaultValue={bk.account_name ?? ''} />
            </div>
            <div>
              <label className="lbl" htmlFor="account_number">Account number</label>
              <input className="inp mono" id="account_number" name="account_number"
                     defaultValue={bk.account_number ?? ''} inputMode="numeric" />
            </div>
          </div>
          <div>
            <label className="lbl" htmlFor="instructions">If the account is not ready</label>
            <input className="inp" id="instructions" name="instructions" defaultValue={bk.instructions ?? ''} />
            <div className="hint">Shown instead of the details when the account number is blank.</div>
          </div>
          <div><button className="btn btn-p" type="submit">Save</button></div>
        </form>
      </div>
    </main>
  );
}
