import Shell from '@/components/Shell';
import { sb } from '@/lib/session';

export const dynamic = 'force-dynamic';

const KIND: Record<string, { label: string; cls: string }> = {
  count: { label: 'Stock count', cls: 'p-sky' },
  fault: { label: 'Fault report', cls: 'p-warn' },
  transfer_request: { label: 'Transfer request', cls: 'p-sky' },
  delivery: { label: 'Delivery confirmed', cls: 'p-ok' },
  meter: { label: 'Meter reading', cls: 'p-mute' },
};

const ago = (iso: string) => {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

export default async function Submissions({ searchParams }: { searchParams: { done?: string } }) {
  const supabase = sb();

  const { data, error } = await supabase
    .from('submissions')
    .select(`id, reference, kind, status, note, submitted_at, device_label,
             link_holders ( name, role_label ), locations ( name )`)
    .order('submitted_at', { ascending: false })
    .limit(100);

  const rows = (data ?? []) as any[];
  const pending = rows.filter((s) => s.status === 'pending');
  const done = rows.filter((s) => s.status !== 'pending');

  const { data: holders } = await supabase
    .from('link_holders')
    .select('id, name, role_label, submissions_total, submissions_clean, variance_sum_pct');

  return (
    <Shell current="submissions" title="Field inbox" subtitle="Sent from location links, waiting for review">
      {searchParams.done && (
        <div className="notice"><p>Reviewed. Everything accepted is now on the register, with the submitter named on the record.</p></div>
      )}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="notice">
        <p>
          Nothing on this page has changed the register. A link holder can send a count, a
          fault or a request — none of it takes effect until a manager confirms it here.
          That is what makes it safe to hand a link to someone with no account.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Waiting for review · {pending.length}</div>
            <div className="card-s">From people who hold a link, not a seat</div>
          </div>
        </div>
        {pending.length === 0 ? (
          <div className="empty">
            <h4>Nothing waiting</h4>
            <p>
              Issue a location link from People, send it over WhatsApp, and whatever comes
              back lands here for you to check.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Reference</th><th>Type</th><th>From</th><th>Location</th><th>When</th><th /></tr>
              </thead>
              <tbody>
                {pending.map((s) => {
                  const k = KIND[s.kind] ?? KIND.count;
                  return (
                    <tr key={s.id}>
                      <td><span className="tag">{s.reference}</span></td>
                      <td><span className={`pill ${k.cls}`}><span className="pd" />{k.label}</span></td>
                      <td>
                        <div className="aname">{s.link_holders?.name ?? 'Unknown'}</div>
                        <div className="amake">{s.link_holders?.role_label ?? ''}</div>
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>{s.locations?.name ?? '—'}</td>
                      <td style={{ color: 'var(--text-3)' }}>{ago(s.submitted_at)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <a className="btn btn-p" href={`/submissions/${s.id}`}>Review</a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(holders ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Who counts carefully</div>
              <div className="card-s">Built from how often each person's figures survived review — never typed in</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Person</th><th>Submissions</th><th>Accepted as sent</th><th>Average variance</th></tr>
              </thead>
              <tbody>
                {(holders ?? []).map((h: any) => {
                  const pct = h.submissions_total > 0
                    ? Math.round((h.submissions_clean / h.submissions_total) * 100) : null;
                  return (
                    <tr key={h.id}>
                      <td>
                        <div className="aname">{h.name}</div>
                        <div className="amake">{h.role_label ?? ''}</div>
                      </td>
                      <td className="mono">{h.submissions_total}</td>
                      <td>
                        {pct === null ? '—' : (
                          <span className={`pill ${pct >= 95 ? 'p-ok' : pct >= 85 ? 'p-warn' : 'p-bad'}`}>
                            <span className="pd" />{pct}%
                          </span>
                        )}
                      </td>
                      <td className="mono" style={{ color: 'var(--text-2)' }}>
                        {h.submissions_total > 0
                          ? (Number(h.variance_sum_pct) / h.submissions_total).toFixed(2) + '%' : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '0 20px 20px' }}>
            <p className="hint">
              This is the part no spreadsheet gives you. It exists only as a by-product of
              reviewing each submission line by line, and it tells you whose figures are
              worth spot-checking.
            </p>
          </div>
        </div>
      )}

      {done.length > 0 && (
        <div className="card">
          <div className="card-h bd"><div><div className="card-t">Recently cleared</div></div></div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Type</th><th>From</th><th>Outcome</th></tr></thead>
              <tbody>
                {done.slice(0, 20).map((s) => (
                  <tr key={s.id}>
                    <td><span className="tag">{s.reference}</span></td>
                    <td>{(KIND[s.kind] ?? KIND.count).label}</td>
                    <td style={{ color: 'var(--text-2)' }}>{s.link_holders?.name ?? '—'}</td>
                    <td>
                      <span className={`pill ${s.status === 'accepted' ? 'p-ok' : 'p-bad'}`}>
                        <span className="pd" />{s.status}
                      </span>
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
