import Shell from '@/components/Shell';
import { sb, canSeeFinancials, getSession, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Depreciation, straight line over each model's service life. The life lives
 * on the catalog model, so the schedule is derived rather than maintained —
 * nobody types a book value, and it cannot drift from the register.
 */
export default async function Reports() {
  const session = await getSession();
  const supabase = sb();

  if (!canSeeFinancials(session)) {
    return (
      <Shell current="reports" title="Reports" subtitle="Depreciation and valuation">
        <div className="card">
          <div className="empty">
            <h4>Not available to your role</h4>
            <p>
              Depreciation is financial reporting. The register itself is fully visible to
              you — this is the one part that is not.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const { data: assets } = await supabase
    .from('assets')
    .select('id, tag, name, acquired_on, status, models ( name, service_life_years )')
    .neq('status', 'retired')
    .order('tag');

  const list = (assets ?? []) as any[];

  const { data: fin } = await supabase
    .from('asset_financials')
    .select('asset_id, purchase_cost_minor');
  const costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f.purchase_cost_minor ?? 0]));

  const year = new Date().getFullYear();
  const rows = list.map((a) => {
    const cost = costs.get(a.id) ?? 0;
    const life = a.models?.service_life_years ?? null;
    const age = a.acquired_on ? Math.max(0, year - new Date(a.acquired_on).getFullYear()) : 0;
    const dep = life ? Math.min(1, age / life) : 0;
    const book = life ? Math.round(cost * (1 - dep)) : cost;
    return { ...a, cost, life, age, dep, book };
  });

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalBook = rows.reduce((s, r) => s + r.book, 0);

  const { data: disposals } = await supabase
    .from('disposals')
    .select('reference, reason, disposed_on, proceeds_minor, book_value_minor, assets ( tag, name )')
    .order('disposed_on', { ascending: false }).limit(20);

  return (
    <Shell current="reports" title="Reports" subtitle="Depreciation, valuation and disposals">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 14, marginBottom: 18 }}>
        {[
          { v: rows.length.toString(), l: 'Assets on the register' },
          { v: money(totalCost), l: 'Purchase cost' },
          { v: money(totalBook), l: 'Book value today' },
          { v: money(totalCost - totalBook), l: 'Depreciated so far' },
        ].map((k) => (
          <div className="card" key={k.l} style={{ padding: 18 }}>
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 800, letterSpacing: '-.03em' }}>{k.v}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 5 }}>{k.l}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Depreciation schedule</div>
            <div className="card-s">
              Straight line over each model&rsquo;s service life. An asset with no model, or a
              model with no life set, shows at full cost.
            </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty"><h4>Nothing to depreciate yet</h4><p>Assets appear here once they are on the register with a purchase cost.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Tag</th><th>Asset</th><th>Acquired</th><th>Life</th><th>Depreciated</th><th>Cost</th><th>Book value</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><span className="tag">{r.tag}</span></td>
                    <td><div className="aname">{r.name}</div><div className="amake">{r.models?.name ?? 'No catalog model'}</div></td>
                    <td style={{ color: 'var(--text-2)' }}>{r.acquired_on ?? '—'}</td>
                    <td className="mono">{r.life ? `${r.life} yrs` : '—'}</td>
                    <td style={{ minWidth: 110 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div style={{ flex: 1, height: 6, borderRadius: 6, background: 'var(--line-2)', overflow: 'hidden' }}>
                          <div style={{ width: `${Math.round(r.dep * 100)}%`, height: '100%', borderRadius: 6, background: r.dep >= 1 ? 'var(--bad)' : r.dep > 0.6 ? 'var(--warn)' : 'var(--brand)' }} />
                        </div>
                        <span className="mono" style={{ fontSize: 12, width: 34 }}>{Math.round(r.dep * 100)}%</span>
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{money(r.cost)}</td>
                    <td className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{money(r.book)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">Disposals</div>
            <div className="card-s">Where things went, and what was recovered</div>
          </div>
        </div>
        {(disposals ?? []).length === 0 ? (
          <div className="empty"><h4>Nothing disposed of yet</h4><p>Sales, scrappings, thefts and write-offs appear here with their evidence.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Asset</th><th>Reason</th><th>When</th><th>Book value</th><th>Proceeds</th><th>Loss</th></tr></thead>
              <tbody>
                {(disposals ?? []).map((d: any) => {
                  const loss = Math.max(0, (d.book_value_minor ?? 0) - (d.proceeds_minor ?? 0));
                  return (
                    <tr key={d.reference}>
                      <td><span className="tag">{d.reference}</span></td>
                      <td><div className="aname">{d.assets?.name}</div><div className="amake"><span className="tag">{d.assets?.tag}</span></div></td>
                      <td><span className={`pill ${d.reason === 'stolen' || d.reason === 'lost' ? 'p-bad' : 'p-mute'}`}><span className="pd" />{d.reason}</span></td>
                      <td style={{ color: 'var(--text-2)' }}>{d.disposed_on}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{money(d.book_value_minor)}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{money(d.proceeds_minor)}</td>
                      <td className="mono" style={{ fontSize: 12.5, color: loss > 0 ? 'var(--bad)' : 'var(--text-3)' }}>{loss > 0 ? money(loss) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  );
}
