import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { resolveDiscrepancy } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Flagging a line on receipt is easy. What happens to that asset afterwards is
 * the part every system skips, and it is where registers quietly rot — an item
 * sits in limbo, nobody owns chasing it, and a year later nobody can say
 * whether it was stolen or simply never loaded.
 *
 * So every discrepancy has an owner, a clock, and exactly three exits.
 */
export default async function Discrepancies({
  searchParams,
}: { searchParams: { error?: string; resolved?: string } }) {
  const supabase = sb();

  const { data, error } = await supabase
    .from('discrepancies')
    .select(`id, reference, kind, note, opened_at, resolved_at, outcome, outcome_note,
             assets ( tag, name ), transfers ( waybill_no, reference )`)
    .order('opened_at', { ascending: false });

  const rows = (data ?? []) as any[];
  const open = rows.filter((d) => !d.resolved_at);
  const closed = rows.filter((d) => d.resolved_at);

  const days = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

  return (
    <Shell current="discrepancies" title="Discrepancies" subtitle="Assets belonging to neither register">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.resolved && <div className="notice"><p>Resolved, and the asset has moved accordingly.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Open · {open.length}</div>
            <div className="card-s">
              These assets are still in transit. The waybill they belong to stays open until
              each one is resolved.
            </div>
          </div>
        </div>
        {open.length === 0 ? (
          <div className="empty">
            <h4>Nothing outstanding</h4>
            <p>Every asset is on a register. That is the state you want the system in.</p>
          </div>
        ) : (
          open.map((d) => (
            <div key={d.id} style={{ padding: '18px 20px', borderBottom: '1px solid var(--line-2)' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div className="aname">{d.assets?.name ?? 'Unknown asset'}</div>
                  <div className="amake">
                    <span className="tag">{d.assets?.tag}</span> · {d.kind} on{' '}
                    <span className="mono">{d.transfers?.waybill_no ?? d.transfers?.reference ?? '—'}</span>
                  </div>
                  {d.note && (
                    <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 8, fontStyle: 'italic' }}>
                      &ldquo;{d.note}&rdquo;
                    </p>
                  )}
                </div>
                <span className={`pill ${days(d.opened_at) > 3 ? 'p-bad' : 'p-warn'}`}>
                  <span className="pd" />
                  {days(d.opened_at)} day{days(d.opened_at) === 1 ? '' : 's'} open
                </span>
              </div>

              {/* One form per outcome, each carrying the same note field, so a
                  manager can record why before choosing. The reason matters more
                  than the button: in three years it is the only thing that
                  explains where something went. */}
              <form action={resolveDiscrepancy} style={{ marginTop: 14 }}>
                <input type="hidden" name="id" value={d.id} />
                <input className="inp" name="note" placeholder="What happened — this is what explains it in three years" />
                <div style={{ display: 'flex', gap: 9, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-p" type="submit" name="outcome" value="found">
                    Found and received
                  </button>
                  <button className="btn btn-g" type="submit" name="outcome" value="written_off">
                    Write it off
                  </button>
                  <button className="btn btn-g" type="submit" name="outcome" value="charged_to_carrier">
                    Charge to the carrier
                  </button>
                </div>
              </form>
              <p className="hint" style={{ marginTop: 10 }}>
                Found puts it on the destination register with a late-receipt note. The other
                two retire it — one as a loss, one as a claim.
              </p>
            </div>
          ))
        )}
      </div>

      {closed.length > 0 && (
        <div className="card">
          <div className="card-h bd">
            <div><div className="card-t">Resolved</div><div className="card-s">How each one ended</div></div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Asset</th><th>Outcome</th><th>Open for</th></tr></thead>
              <tbody>
                {closed.map((d) => (
                  <tr key={d.id}>
                    <td><span className="tag">{d.reference}</span></td>
                    <td><div className="aname">{d.assets?.name}</div><div className="amake"><span className="tag">{d.assets?.tag}</span></div></td>
                    <td>
                      <span className={`pill ${d.outcome === 'found' ? 'p-ok' : 'p-warn'}`}>
                        <span className="pd" />{String(d.outcome).replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="mono">
                      {Math.max(0, Math.floor((new Date(d.resolved_at).getTime() - new Date(d.opened_at).getTime()) / 86_400_000))} days
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Shell>
  );
}
