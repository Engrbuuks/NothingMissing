import Shell from '@/components/Shell';
import { sb, getSession, hasRole, money } from '@/lib/session';
import { startPayment } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Billing({
  searchParams,
}: { searchParams: { error?: string; returned?: string; recorded?: string } }) {
  const session = await getSession();
  const supabase = sb();

  if (!hasRole(session, 'owner', 'admin')) {
    return (
      <Shell current="billing" title="Billing" subtitle="Plan and usage">
        <div className="card"><div className="empty"><h4>Not available to your role</h4>
        <p>Only an owner or admin can see what the company pays.</p></div></div>
      </Shell>
    );
  }

  const { data: co } = await supabase.from('companies').select('id, name').limit(1).maybeSingle();
  const { data: b, error } = co
    ? await supabase.rpc('billing_summary', { p_company: (co as any).id })
    : { data: null, error: null as any };

  const { data: proofs } = await supabase
    .from('payment_proofs')
    .select('reference, amount_minor, paid_on, status, submitted_at, review_note')
    .order('submitted_at', { ascending: false })
    .limit(5);

  const { data: events } = await supabase
    .from('billing_events')
    .select('kind, amount_minor, reference, at')
    .order('at', { ascending: false })
    .limit(10);

  const s = (b ?? {}) as any;
  // Read on the server: the key never reaches the browser, and the page shows
  // the honest state rather than a button that cannot work.
  const live = Boolean(process.env.PAYSTACK_SECRET_KEY);
  const trialDays = s.trial_ends_on
    ? Math.ceil((new Date(s.trial_ends_on).getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <Shell current="billing" title="Billing" subtitle="What you are on, and what it costs">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.recorded && (
        <div className="notice">
          <p>
            <b>Thank you — we have your transfer.</b> We check each one against the account
            before crediting it, usually within a few hours during the working day. Nothing
            is restricted while you wait.
          </p>
        </div>
      )}
      {searchParams.returned && (
        <div className="notice">
          <p>
            <b>Thanks — we are confirming with Paystack.</b> Payment is confirmed server to
            server rather than by this page, so it will show below within a moment even if
            your connection dropped on the way back.
          </p>
        </div>
      )}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {s.status === 'trialing' && trialDays !== null && (
        <div className="notice">
          <p>
            <b>{trialDays > 0 ? `${trialDays} days left in your trial.` : 'Your trial has ended.'}</b>{' '}
            Nothing is restricted while you decide, and nothing is charged until you enter a
            card. Below 50 assets the Starter tier stays free indefinitely.
          </p>
        </div>
      )}

      <div className="kpis" style={{ marginBottom: 18 }}>
        {[
          { v: String(s.assets ?? 0), l: 'Assets on the register', c: '#5B4BE8', s: '#EEEBFE' },
          { v: String(s.free_allowance ?? 50), l: 'Included free', c: '#0FA45E', s: '#E4F7ED' },
          { v: String(s.billable ?? 0), l: 'Chargeable', c: '#E39A11', s: '#FDF3E0' },
          { v: money(s.monthly_minor ?? 0), l: 'Per month at today’s count', c: '#0EA5B7', s: '#E2F6F8' },
        ].map((k) => (
          <div className="kpi" key={k.l}>
            <div className="kpi-top">
              <span className="kpi-ic" style={{ background: k.s, color: k.c }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: k.c, display: 'block' }} />
              </span>
            </div>
            <div className="kpi-v" style={{ color: k.c }}>{k.v}</div>
            <div className="kpi-l">{k.l}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Your plan</div>
            <div className="card-s">
              Counted from your register, not from a stored number — so this is the same
              figure your dashboard shows
            </div>
          </div>
          <span className={`pill ${s.status === 'active' ? 'p-ok' : s.status === 'past_due' ? 'p-bad' : 'p-warn'}`}
                style={{ marginLeft: 'auto' }}>
            <span className="pd" />{s.status ?? 'trialing'}
          </span>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr><td style={{ color: 'var(--text-3)' }}>Tier</td><td style={{ textTransform: 'capitalize' }}>{s.tier}</td></tr>
              <tr><td style={{ color: 'var(--text-3)' }}>Rate</td>
                  <td className="mono">{money(s.rate_minor ?? 18000)} per asset, per month</td></tr>
              <tr><td style={{ color: 'var(--text-3)' }}>Next charge</td>
                  <td>{s.current_period_end ?? 'No card on file — nothing will be charged'}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {s.over_free_limit && (
        <div className="notice warn">
          <p>
            <b>You are past the free allowance.</b> Nothing has been restricted and nothing
            has been charged. Add a payment method when you are ready — we would rather you
            decided the product was worth it than discovered a locked screen.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Payment method</div>
            <div className="card-s">Card or bank transfer through Paystack</div>
          </div>
        </div>
        <div style={{ padding: 20 }}>
          {live ? (
            <>
              <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.65, maxWidth: '60ch' }}>
                Card, bank transfer, USSD or direct debit through Paystack. The amount is
                calculated from your register at the moment you pay, so it always matches the
                figure above.
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                <a className="btn btn-g" href="/billing/transfer">Pay by bank transfer instead</a>
              </div>
              <form action={startPayment} style={{ marginTop: 16 }}>
                <button className="btn btn-p" type="submit"
                        disabled={(s.monthly_minor ?? 0) <= 0}>
                  {(s.monthly_minor ?? 0) > 0
                    ? `Pay ${money(s.monthly_minor)} for this month`
                    : 'Nothing to pay — you are within the free allowance'}
                </button>
              </form>
            </>
          ) : (
            <>
              <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.65, maxWidth: '60ch' }}>
                Paystack is wired but no live business account is connected yet, so nothing
                can be charged — which is also why nothing is restricted. If you want to pay
                now, email us and we will invoice you directly.
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                <a className="btn btn-p" href="/billing/transfer">Pay by bank transfer</a>
                <a className="btn btn-g" href="/pricing">See the pricing</a>
              </div>
            </>
          )}
        </div>
      </div>

      {(proofs ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Transfers you have recorded</div>
              <div className="card-s">We confirm each against the account before crediting it</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Amount</th><th>Paid on</th><th>Status</th></tr></thead>
              <tbody>
                {(proofs ?? []).map((p: any) => (
                  <tr key={p.reference}>
                    <td><span className="tag">{p.reference}</span></td>
                    <td className="mono">{money(p.amount_minor)}</td>
                    <td style={{ color: 'var(--text-2)' }}>{p.paid_on}</td>
                    <td>
                      <span className={`pill ${p.status === 'verified' ? 'p-ok' : p.status === 'rejected' ? 'p-bad' : 'p-warn'}`}>
                        <span className="pd" />
                        {p.status === 'submitted' ? 'Awaiting confirmation' : p.status}
                      </span>
                      {p.review_note && <div className="amake" style={{ marginTop: 4 }}>{p.review_note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h bd">
          <div><div className="card-t">History</div><div className="card-s">Charges and changes</div></div>
        </div>
        {(events ?? []).length === 0 ? (
          <div className="empty"><h4>Nothing charged yet</h4>
          <p>Invoices and payments appear here once billing is live.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>What</th><th>Reference</th><th>Amount</th></tr></thead>
              <tbody>
                {(events ?? []).map((e: any, i: number) => (
                  <tr key={i}>
                    <td style={{ color: 'var(--text-2)' }}>{new Date(e.at).toLocaleDateString('en-GB')}</td>
                    <td>{e.kind}</td>
                    <td><span className="tag">{e.reference ?? '—'}</span></td>
                    <td className="mono">{money(e.amount_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  );
}
