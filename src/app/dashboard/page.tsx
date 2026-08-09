import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The dashboard. Three bands, in this order, because that is the order the
 * questions actually arrive in:
 *
 *   1. What needs me today — actions, not metrics. This is why someone opens
 *      the app in the morning, so it sits above everything decorative.
 *   2. What I have — the estate at a glance, by status and category.
 *   3. What is moving — assets between registers, with an ageing clock.
 *
 * Every figure is a count from the database, scoped by row-level security.
 * Nothing here is computed from a cached number, so it cannot drift.
 */

const short = (minor: number) => {
  const n = minor / 100;
  if (n >= 1e9) return '₦' + (n / 1e9).toFixed(1) + 'b';
  if (n >= 1e6) return '₦' + (n / 1e6).toFixed(1) + 'm';
  if (n >= 1e3) return '₦' + Math.round(n / 1e3) + 'k';
  return '₦' + Math.round(n);
};

const STATUS_META: Record<string, { label: string; colour: string }> = {
  active: { label: 'In service', colour: '#0FA45E' },
  transit: { label: 'In transit', colour: '#2E7FF0' },
  repair: { label: 'In repair', colour: '#E39A11' },
  idle: { label: 'Unassigned', colour: '#9296AC' },
  retired: { label: 'Retired', colour: '#E14B42' },
};

export default async function Dashboard() {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const count = async (table: string, apply?: (q: any) => any) => {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (apply) q = apply(q);
    const { count: n } = await q;
    return n ?? 0;
  };

  // --- band one: what needs you ---------------------------------------------
  const [pendingSubs, openDiscrepancies, pendingRequests, inTransit] = await Promise.all([
    count('submissions', (q) => q.eq('status', 'pending')),
    count('discrepancies', (q) => q.is('resolved_at', null)),
    count('requests', (q) => q.eq('status', 'pending')),
    count('transfers', (q) => q.eq('status', 'in_transit')),
  ]);

  // --- band two: what you have ----------------------------------------------
  const { data: assets } = await supabase
    .from('assets')
    .select('id, status, models ( sub_categories ( categories ( name ) ) )');

  const list = (assets ?? []) as any[];
  const byStatus = Object.keys(STATUS_META).map((k) => ({
    key: k,
    ...STATUS_META[k],
    n: list.filter((a) => a.status === k).length,
  }));
  const live = list.filter((a) => a.status !== 'retired').length;

  const byCategory = new Map<string, number>();
  for (const a of list) {
    if (a.status === 'retired') continue;
    const name = a.models?.sub_categories?.categories?.name ?? 'Uncategorised';
    byCategory.set(name, (byCategory.get(name) ?? 0) + 1);
  }
  const categories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  let estateValue = 0;
  if (showCost) {
    const { data: fin } = await supabase.from('asset_financials').select('purchase_cost_minor');
    estateValue = (fin ?? []).reduce((s: number, f: any) => s + (f.purchase_cost_minor ?? 0), 0);
  }

  const [locationCount, stockLow] = await Promise.all([
    count('locations', (q) => q.is('archived_at', null)),
    (async () => {
      const { data } = await supabase.from('stock_balances').select('qty, stock_items ( reorder_point )');
      return (data ?? []).filter(
        (b: any) => Number(b.qty) < Number(b.stock_items?.reorder_point ?? 0)
      ).length;
    })(),
  ]);

  // --- band three: what is moving -------------------------------------------
  const { data: moving } = await supabase
    .from('transfers')
    .select('id, reference, waybill_no, dispatched_at, from:from_location ( name ), to:to_location ( name ), transfer_lines ( count )')
    .eq('status', 'in_transit')
    .order('dispatched_at', { ascending: true })
    .limit(6);

  const { data: recent } = await supabase
    .from('audit_events')
    .select('id, occurred_at, actor_label, action, detail, tone')
    .order('occurred_at', { ascending: false })
    .limit(8);

  const days = (iso: string | null) =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

  const actions = [
    { n: pendingRequests, label: 'Awaiting approval', href: '/requests', colour: '#5B4BE8' },
    { n: pendingSubs, label: 'Field submissions to review', href: '/submissions', colour: '#0EA5B7' },
    { n: inTransit, label: 'Consignments in transit', href: '/transfers', colour: '#2E7FF0' },
    { n: openDiscrepancies, label: 'Open discrepancies', href: '/discrepancies', colour: '#E14B42' },
  ];

  const needsYou = actions.reduce((s, a) => s + a.n, 0);
  const firstName = (session?.fullName ?? session?.email ?? '').split(/[\s@.]/)[0];

  // A genuinely new account: say so, and offer the first useful step rather
  // than a wall of zeroes that reads as broken.
  if (live === 0 && locationCount <= 1) {
    return (
      <Shell current="dashboard" title="Dashboard" subtitle="Nothing on the register yet">
        <div className="card">
          <div className="empty">
            <h4>Welcome{firstName ? `, ${firstName}` : ''}</h4>
            <p>
              Your company exists and you are its owner. Nothing is on the register yet, so
              there is nothing to report. Most registers start as a spreadsheet — importing
              one is usually faster than adding assets by hand.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
              <a className="btn btn-p" href="/import">Import a spreadsheet</a>
              <a className="btn btn-g" href="/locations">Add your locations first</a>
              <a className="btn btn-g" href="/catalog">Set up the catalog</a>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      current="dashboard"
      title={`Good day${firstName ? `, ${firstName}` : ''}`}
      subtitle={
        needsYou > 0
          ? `${needsYou} thing${needsYou === 1 ? '' : 's'} need you today`
          : 'Nothing is waiting on you'
      }
    >
      {/* ---- what needs you ---- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginBottom: 22 }}>
        {actions.map((a) => (
          <a className="card" key={a.label} href={a.href} style={{ padding: 18, display: 'block' }}>
            <div
              style={{
                fontFamily: 'var(--display)', fontSize: 30, fontWeight: 800,
                letterSpacing: '-.04em', lineHeight: 1,
                color: a.n > 0 ? a.colour : 'var(--text-3)',
              }}
            >
              {a.n}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 7, fontWeight: 500 }}>
              {a.label}
            </div>
          </a>
        ))}
      </div>

      {/* ---- what you have ---- */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Your register</div>
            <div className="card-s">
              {live} live asset{live === 1 ? '' : 's'} across {locationCount} location
              {locationCount === 1 ? '' : 's'}
              {showCost ? ` · ${short(estateValue)} at purchase cost` : ' · value not visible to your role'}
            </div>
          </div>
          <a className="btn btn-g" href="/assets" style={{ marginLeft: 'auto' }}>Open the register</a>
        </div>

        <div style={{ padding: '18px 20px' }}>
          {/* A proportional bar rather than five separate numbers: the shape of
              the estate is the thing worth seeing at a glance. */}
          <div style={{ display: 'flex', height: 12, borderRadius: 8, overflow: 'hidden', gap: 2, background: 'var(--line-2)' }}>
            {byStatus.filter((s) => s.n > 0).map((s) => (
              <div key={s.key} style={{ flex: s.n, background: s.colour }} title={`${s.label}: ${s.n}`} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14 }}>
            {byStatus.filter((s) => s.n > 0).map((s) => (
              <span key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)' }}>
                <i style={{ width: 9, height: 9, borderRadius: 3, background: s.colour }} />
                {s.label}
                <b style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{s.n}</b>
              </span>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <div className="tbl-wrap" style={{ borderTop: '1px solid var(--line-2)' }}>
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>Category</th><th>Assets</th><th>Share</th></tr></thead>
              <tbody>
                {categories.map(([name, n]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="mono">{n}</td>
                    <td style={{ width: '50%' }}>
                      <div style={{ height: 6, borderRadius: 6, background: 'var(--line-2)', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.round((n / live) * 100)}%`, height: '100%', background: 'var(--brand)', borderRadius: 6 }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {stockLow > 0 && (
        <div className="notice warn">
          <p>
            <b>{stockLow} stock line{stockLow === 1 ? '' : 's'} below the reorder point.</b>{' '}
            Lead times are measured from your own orders, so the clock on replacing them has
            already started. <a href="/inventory" style={{ textDecoration: 'underline' }}>Open inventory</a>.
          </p>
        </div>
      )}

      {/* ---- what is moving ---- */}
      {(moving ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">In transit</div>
              <div className="card-s">
                These belong to neither register until someone at the destination confirms
                they arrived
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Waybill</th><th>Route</th><th>Assets</th><th>Days out</th><th /></tr></thead>
              <tbody>
                {(moving ?? []).map((t: any) => {
                  const d = days(t.dispatched_at);
                  return (
                    <tr key={t.id}>
                      <td><span className="tag">{t.waybill_no ?? t.reference}</span></td>
                      <td>{t.from?.name ?? '—'} → <b>{t.to?.name ?? '—'}</b></td>
                      <td className="mono">{t.transfer_lines?.[0]?.count ?? 0}</td>
                      <td>
                        <span className={`pill ${d !== null && d > 3 ? 'p-bad' : 'p-sky'}`}>
                          <span className="pd" />{d === null ? '—' : `${d} day${d === 1 ? '' : 's'}`}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <a className="btn btn-g" href={`/transfers/${t.id}`}>Receive</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">Recent activity</div>
            <div className="card-s">Every movement writes to the audit log, which nobody can edit</div>
          </div>
          <a className="btn btn-g" href="/audit" style={{ marginLeft: 'auto' }}>Full log</a>
        </div>
        {(recent ?? []).length === 0 ? (
          <div className="empty">
            <h4>Nothing has happened yet</h4>
            <p>Movements, approvals and adjustments appear here as they are recorded.</p>
          </div>
        ) : (
          <div style={{ padding: '4px 20px 18px' }}>
            {(recent ?? []).map((e: any) => (
              <div key={e.id} style={{ display: 'flex', gap: 14, padding: '13px 0', borderBottom: '1px solid var(--line-2)' }}>
                <span
                  className={`pill ${e.tone === 'ok' ? 'p-ok' : e.tone === 'warn' ? 'p-warn' : e.tone === 'bad' ? 'p-bad' : 'p-mute'}`}
                  style={{ flex: 'none', alignSelf: 'flex-start' }}
                >
                  <span className="pd" />{e.action}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>{e.detail ?? '—'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3 }}>
                    {e.actor_label} · {new Date(e.occurred_at).toLocaleString('en-GB')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
