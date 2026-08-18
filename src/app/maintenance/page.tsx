import Shell from '@/components/Shell';
import { sb, money, canSeeFinancials, canWrite, getSession } from '@/lib/session';
import { logService, returnToService } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * What is due for service, computed from the catalog model's interval and the
 * asset's meter. Because the interval lives on the model rather than the
 * asset, buying six more of something schedules all six with no configuration.
 */
export default async function Maintenance({
  searchParams,
}: { searchParams: { error?: string; returned?: string; logged?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const { data: due, error } = co
    ? await supabase.rpc('maintenance_due', { p_company: co.id })
    : { data: [] as any[], error: null as any };

  const rows = (due ?? []) as any[];
  const overdue = rows.filter((r) => r.state === 'overdue');
  const soon = rows.filter((r) => r.state === 'due_soon');

  const { data: inRepair } = await supabase
    .from('assets').select('id, tag, name').eq('status', 'repair');

  const { data: history } = await supabase
    .from('maintenance_events')
    .select('id, performed_on, kind, cost_minor, vendor, note, assets ( tag, name )')
    .order('performed_on', { ascending: false }).limit(20);

  const STATE: Record<string, { label: string; cls: string }> = {
    overdue: { label: 'Overdue', cls: 'p-bad' },
    due_soon: { label: 'Due soon', cls: 'p-warn' },
    ok: { label: 'In good standing', cls: 'p-ok' },
    not_scheduled: { label: 'No interval set', cls: 'p-mute' },
  };

  return (
    <Shell current="maintenance" title="Maintenance" subtitle="What is due for service, and when">
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {canWrite(session) && (
          <a className="btn btn-p" href="/maintenance/new">Log maintenance</a>
        )}
        <a className="btn btn-g" href="/assets?status=repair">Assets in repair</a>
      </div>

      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.logged && (
        <div className="notice"><p>Recorded on the asset&rsquo;s history.</p></div>
      )}
      {searchParams.returned && <div className="notice"><p>Back in service, and the repair is on the asset&rsquo;s history.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 14, marginBottom: 18 }}>
        {[
          { n: overdue.length, l: 'Past due', c: 'var(--bad)' },
          { n: soon.length, l: 'Due within 10%', c: 'var(--warn)' },
          { n: (inRepair ?? []).length, l: 'Out for repair', c: 'var(--sky)' },
          { n: rows.length, l: 'On a service plan', c: 'var(--brand)' },
        ].map((k) => (
          <div className="card" key={k.l} style={{ padding: 18 }}>
            <div style={{ fontFamily: 'var(--display)', fontSize: 26, fontWeight: 800, color: k.c, letterSpacing: '-.03em' }}>{k.n}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 5 }}>{k.l}</div>
          </div>
        ))}
      </div>

      {(inRepair ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Out for repair · {(inRepair ?? []).length}</div>
              <div className="card-s">
                Closing a repair is the step that gets forgotten, which is how something ends
                up marked In repair eighteen months after it came back.
              </div>
            </div>
          </div>
          {(inRepair ?? []).map((a: any) => (
            <form action={returnToService} key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--line-2)', flexWrap: 'wrap' }}>
              <input type="hidden" name="id" value={a.id} />
              <div style={{ flex: 1, minWidth: 160 }}>
                <div className="aname">{a.name}</div>
                <div className="amake"><span className="tag">{a.tag}</span></div>
              </div>
              <select className="inp" name="outcome" style={{ width: 230 }}>
                <option>Repaired and working</option>
                <option>Repaired, with a residual fault</option>
                <option>Could not be repaired</option>
              </select>
              <input className="inp" name="cost" placeholder="Final cost" style={{ width: 130 }} />
              <input className="inp" name="note" placeholder="What was done"
                              style={{ flex: 1, minWidth: 150, padding: '6px 10px', fontSize: 12.5 }} />
                       <button className="btn btn-p" type="submit">Return to service</button>
            </form>
          ))}
          <p className="hint" style={{ padding: '14px 20px' }}>
            &ldquo;Could not be repaired&rdquo; does not silently retire the asset — it has to go
            through disposal, so a reason and evidence are recorded.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Service schedule</div>
            <div className="card-s">Intervals come from the catalog model, so every unit of a model is scheduled the same way</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>Nothing on a service plan yet</h4>
            <p>
              Set a service interval on a catalog model — hours for a generator, kilometres
              for a vehicle — and every unit of that model appears here automatically.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Asset</th><th>Since last</th><th>Interval</th><th>Progress</th><th>State</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const st = STATE[r.state] ?? STATE.ok;
                  const pct = Math.min(100, Number(r.pct ?? 0));
                  const col = r.state === 'overdue' ? 'var(--bad)' : r.state === 'due_soon' ? 'var(--warn)' : 'var(--ok)';
                  return (
                    <tr key={r.asset_id}>
                      <td><div className="aname">{r.name}</div><div className="amake"><span className="tag">{r.tag}</span></div></td>
                      <td className="mono">{Number(r.since_last ?? 0).toLocaleString()} {r.unit}</td>
                      <td className="mono">{Number(r.interval_size ?? 0).toLocaleString()}</td>
                      <td style={{ minWidth: 120 }}>
                        <div style={{ height: 6, borderRadius: 6, background: 'var(--line-2)', overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 6 }} />
                        </div>
                      </td>
                      <td><span className={`pill ${st.cls}`}><span className="pd" />{st.label}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <form action={logService.bind(null, r.asset_id)}>
                          <button className="btn btn-g" type="submit">Log service</button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h bd">
          <div><div className="card-t">Service history</div><div className="card-s">Every service and repair, most recent first</div></div>
        </div>
        {(history ?? []).length === 0 ? (
          <div className="empty"><h4>Nothing logged yet</h4><p>Services and repairs appear here as they are recorded.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Asset</th><th>What</th><th>Vendor</th>{canSeeFinancials(session) && <th>Cost</th>}</tr></thead>
              <tbody>
                {(history ?? []).map((h: any) => (
                  <tr key={h.id}>
                    <td style={{ color: 'var(--text-2)' }}>{h.performed_on}</td>
                    <td><div className="aname">{h.assets?.name}</div><div className="amake"><span className="tag">{h.assets?.tag}</span></div></td>
                    <td style={{ color: 'var(--text-2)' }}>{h.kind ?? '—'}{h.note ? ` · ${h.note}` : ''}</td>
                    <td style={{ color: 'var(--text-2)' }}>{h.vendor ?? '—'}</td>
                    {canSeeFinancials(session) && <td className="mono" style={{ fontSize: 12.5 }}>{money(h.cost_minor)}</td>}
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
