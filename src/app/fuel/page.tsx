import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The fuel check.
 *
 * Fuel goes down three ways and only one is deliberate: it is burned, it
 * evaporates and leaks, or it walks. This compares litres issued against what
 * each engine could physically have burned between two meter readings, and
 * gives the difference in litres — a number somebody can go and look for.
 *
 * The per-asset function has existed since 0006 but needed you to already know
 * which generator to suspect, which is the thing you do not know. This is the
 * fleet view, worst first.
 */
export default async function Fuel({
  searchParams,
}: { searchParams: { days?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const days = Number(searchParams.days ?? 30);

  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const from = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = co
    ? await supabase.rpc('fuel_fleet', {
        p_company: (co as any).id,
        p_from: from,
        p_to: new Date().toISOString(),
      })
    : { data: [], error: null as any };

  const rows = (data ?? []) as any[];
  const flagged = rows.filter((r) => r.verdict === 'investigate');
  const questions = rows.filter((r) => r.verdict === 'worth a question');
  const unusable = rows.filter((r) => ['no rate on the model', 'no meter readings', 'no run time recorded'].includes(r.verdict));
  const totalGap = flagged.reduce((s, r) => s + Number(r.gap_litres ?? 0), 0);

  const tone = (v: string) =>
    v === 'investigate' ? 'p-bad'
    : v === 'worth a question' ? 'p-warn'
    : v === 'normal' ? 'p-ok' : 'p-mute';

  return (
    <Shell current="fuel" title="Fuel check" subtitle={`Issued against what the engines could burn · last ${days} days`}>
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <form className="toolbar" method="get" action="/fuel">
        <select className="sel" name="days" defaultValue={String(days)}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="365">Last year</option>
        </select>
        <button className="btn btn-g" type="submit">Apply</button>
      </form>

      <div className="kpis" style={{ marginBottom: 18 }}>
        {[
          { v: String(rows.length), l: 'Engines fuelled', c: '#0551BD', s: '#E7EFFC' },
          { v: String(flagged.length), l: 'Worth investigating', c: '#E14B42', s: '#FDECEB' },
          { v: totalGap > 0 ? `${Math.round(totalGap).toLocaleString()} L` : '—', l: 'Unaccounted for', c: '#E39A11', s: '#FDF3E0' },
          { v: String(unusable.length), l: 'Cannot be checked yet', c: '#9296AC', s: '#F1F2F8' },
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

      {flagged.length > 0 && (
        <div className="notice warn">
          <p>
            <b>{Math.round(totalGap).toLocaleString()} litres more issued than could have been
            burned</b>, across {flagged.length} machine{flagged.length === 1 ? '' : 's'}. That
            is not proof of anything — meters get misread and generators idle — but it is
            where to look first.
          </p>
        </div>
      )}

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">Every engine fuelled in the period</div>
            <div className="card-s">
              Worst first. Anything within 10% is normal — a dipstick on a 2,000 litre tank
              is not accurate to the litre.
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <h4>Nothing to check yet</h4>
            <p>
              This fills in once fuel is issued <b>against a named asset</b> with a meter
              reading. On the inventory page, choose the machine when recording an issue —
              without that there is nothing to compare against.
            </p>
            <a className="btn btn-p" href="/inventory" style={{ marginTop: 18 }}>Go to inventory</a>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th><th>Location</th><th>Hours run</th><th>Issued</th>
                  <th>Could burn</th><th>Gap</th><th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.asset_id}>
                    <td>
                      <a href={`/assets/${r.asset_id}`}>
                        <div className="aname">{r.name}</div>
                        <div className="amake"><span className="tag">{r.tag}</span></div>
                      </a>
                    </td>
                    <td style={{ color: 'var(--text-2)' }}>{r.location ?? '—'}</td>
                    <td className="mono">{r.hours_run ? Number(r.hours_run).toFixed(0) : '—'}</td>
                    <td className="mono">{Number(r.litres_issued).toLocaleString()} L</td>
                    <td className="mono" style={{ color: 'var(--text-2)' }}>
                      {r.litres_expected !== null ? `${Number(r.litres_expected).toLocaleString()} L` : '—'}
                    </td>
                    <td className="mono" style={{
                      fontWeight: 600,
                      color: r.gap_litres > 0 ? 'var(--bad)' : r.gap_litres < 0 ? 'var(--warn)' : 'var(--text-2)',
                    }}>
                      {r.gap_litres !== null
                        ? `${r.gap_litres > 0 ? '+' : ''}${Number(r.gap_litres).toLocaleString()} L`
                        : '—'}
                      {r.gap_pct !== null && (
                        <div className="amake">{r.gap_pct > 0 ? '+' : ''}{r.gap_pct}%</div>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${tone(r.verdict)}`}><span className="pd" />{r.verdict}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {unusable.length > 0 && (
          <p className="hint" style={{ padding: '16px 20px' }}>
            {unusable.length} machine{unusable.length === 1 ? '' : 's'} cannot be checked yet.
            A model needs a fuel-use rate in the catalog, and each refuel needs a meter
            reading — two readings are needed before hours run can be worked out at all.
          </p>
        )}
      </div>
    </Shell>
  );
}
