import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { reviewSubmission } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function ReviewSubmission({
  params, searchParams,
}: { params: { id: string }; searchParams: { error?: string } }) {
  const supabase = sb();

  const { data: s, error } = await supabase
    .from('submissions')
    .select(`id, reference, kind, status, note, submitted_at, device_label, count_id,
             fault_kind, meter_value,
             link_holders ( name, role_label, submissions_total, submissions_clean ),
             locations ( name ), assets ( tag, name )`)
    .eq('id', params.id)
    .maybeSingle();

  if (error || !s) {
    return (
      <Shell current="submissions" title="Submission" subtitle="Not found">
        <div className="notice bad"><p>{error?.message ?? 'That submission is not visible to you.'}</p></div>
      </Shell>
    );
  }

  const sub = s as any;

  // For a count, show what they counted next to what the system thinks. The
  // submitter never saw the system figure — if they had, they would have
  // agreed with it and the count would be worthless.
  let lines: any[] = [];
  if (sub.count_id) {
    const { data } = await supabase
      .from('stock_count_lines')
      .select('id, book_qty, counted_qty, note, stock_items ( sku, name, unit )')
      .eq('count_id', sub.count_id);
    lines = data ?? [];
  }

  const variances = lines.filter((l) => Number(l.counted_qty) !== Number(l.book_qty));
  const holder = sub.link_holders;
  const record = holder?.submissions_total > 0
    ? Math.round((holder.submissions_clean / holder.submissions_total) * 100) : null;

  return (
    <Shell current="submissions" title={sub.reference} subtitle={`${sub.kind} from ${holder?.name ?? 'unknown'}`}>
      <a className="btn btn-g" href="/submissions" style={{ marginBottom: 18 }}>Back to the inbox</a>

      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Who sent it</div>
            <div className="card-s">Nothing on the register has changed. It changes when you accept.</div>
          </div>
          <span className={`pill ${sub.status === 'pending' ? 'p-warn' : 'p-ok'}`} style={{ marginLeft: 'auto' }}>
            <span className="pd" />{sub.status}
          </span>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Submitted by</td>
                <td>{holder?.name ?? '—'} <span style={{ color: 'var(--text-3)' }}>{holder?.role_label ?? ''}</span></td>
                <td style={{ color: 'var(--text-3)' }}>Their record</td>
                <td>{record === null ? 'First submission' : `${record}% accepted as sent`}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Location</td>
                <td>{sub.locations?.name ?? '—'}</td>
                <td style={{ color: 'var(--text-3)' }}>Device</td>
                <td>{sub.device_label ?? '—'}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>When</td>
                <td>{new Date(sub.submitted_at).toLocaleString('en-GB')}</td>
                <td style={{ color: 'var(--text-3)' }}>Asset</td>
                <td>{sub.assets ? `${sub.assets.tag} — ${sub.assets.name}` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {sub.note && (
          <div style={{ padding: 20, borderTop: '1px solid var(--line-2)' }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }}>
              What they wrote
            </div>
            <p style={{ fontStyle: 'italic', color: 'var(--text-2)', lineHeight: 1.6 }}>“{sub.note}”</p>
          </div>
        )}
      </div>

      {lines.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">{lines.length} line{lines.length === 1 ? '' : 's'} counted · {variances.length} differ</div>
              <div className="card-s">
                They never saw the system figure. If they had, they would have agreed with it.
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Item</th><th>System</th><th>Counted</th><th>Variance</th></tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const diff = Number(l.counted_qty) - Number(l.book_qty);
                  const pct = Number(l.book_qty) ? Math.round(Math.abs(diff) / Number(l.book_qty) * 100) : 100;
                  return (
                    <tr key={l.id} style={diff ? { background: 'var(--warn-soft)' } : undefined}>
                      <td>
                        <div className="aname">{l.stock_items?.name}</div>
                        <div className="amake"><span className="tag">{l.stock_items?.sku}</span> · {l.stock_items?.unit}</div>
                      </td>
                      <td className="mono" style={{ color: 'var(--text-3)' }}>{Number(l.book_qty).toLocaleString()}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>{Number(l.counted_qty).toLocaleString()}</td>
                      <td>
                        {diff === 0 ? (
                          <span className="pill p-ok"><span className="pd" />match</span>
                        ) : (
                          <span className={`pill ${diff < 0 ? 'p-bad' : 'p-warn'}`}>
                            <span className="pd" />{diff > 0 ? '+' : ''}{diff} · {pct}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sub.status === 'pending' && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Your decision</div>
              <div className="card-s">
                {sub.kind === 'count'
                  ? 'Accepting writes the counted figures to the register as adjustments, each carrying the counter’s name'
                  : sub.kind === 'fault'
                    ? 'Accepting marks the asset In repair so nobody requisitions something that is sitting unusable'
                    : 'Accepting acts on what was sent'}
              </div>
            </div>
          </div>
          <form action={reviewSubmission} style={{ padding: 20, display: 'grid', gap: 12 }}>
            <input type="hidden" name="id" value={sub.id} />
            <input className="inp" name="note" placeholder="A note for the record, and for the person who sent it" />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-p" type="submit" name="decision" value="accept">
                Accept and apply
              </button>
              <button className="btn btn-g" type="submit" name="decision" value="reject">
                Reject
              </button>
            </div>
            <div className="hint">
              Rejecting keeps the system figures and sends your reason back to the submitter.
              Either way their accuracy record updates, which is how you learn whose counts to trust.
            </div>
          </form>
        </div>
      )}
    </Shell>
  );
}
