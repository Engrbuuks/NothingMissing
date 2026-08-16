import Shell from '@/components/Shell';
import { sb, money } from '@/lib/session';
import { decideRequest } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const STATE: Record<string, string> = {
  draft: 'p-mute', pending: 'p-warn', approved: 'p-ok',
  rejected: 'p-bad', cancelled: 'p-mute', fulfilled: 'p-ok',
};

export default async function Requests({ searchParams }: { searchParams: { error?: string; raised?: string; decided?: string } }) {
  const supabase = sb();

  const { data, error } = await supabase
    .from('requests')
    .select(`id, reference, kind, status, title, detail, amount_minor, item_count,
             current_step, raised_at, locations ( name ),
             request_steps ( step_no, required_role, status, decided_at )`)
    .order('raised_at', { ascending: false })
    .limit(100);

  const rows = (data ?? []) as any[];
  const pending = rows.filter((r) => r.status === 'pending');

  return (
    <Shell current="requests" title="Requests" subtitle="Transfer, repair and purchase approvals">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.raised && (
        <div className="notice">
          <p>
            <b>Raised.</b> It is now with whoever your approval rules name — you will see it
            move through the chain below.
          </p>
        </div>
      )}
      {searchParams.decided && <div className="notice"><p>Recorded, with your name against it.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="notice">
        <p>
          Approval rules are data, not code — a policy is a row with ordered steps and
          bounds. Nobody approves their own request whatever role they hold, and a request
          that times out escalates to another person rather than approving itself.
        </p>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{pending.length} awaiting a decision</div>
            <div className="card-s">Oldest first — visible waiting time is what makes approvals happen</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>No requests yet</h4>
            <p>
              Transfers of five or more assets, repairs above your threshold, and every
              purchase route through here for approval.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Reference</th><th>What</th><th>Value</th><th>Chain</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const steps = (r.request_steps ?? []).sort((a: any, b: any) => a.step_no - b.step_no);
                  return (
                    <tr key={r.id}>
                      <td><span className="tag">{r.reference}</span></td>
                      <td>
                        <div className="aname">{r.title}</div>
                        <div className="amake">{r.kind} · {r.locations?.name ?? '—'}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>
                        {r.amount_minor ? money(r.amount_minor) : r.item_count ? `${r.item_count} items` : '—'}
                      </td>
                      <td>
                        {steps.map((s: any) => (
                          <span key={s.step_no}
                            className={`pill ${s.status === 'approved' ? 'p-ok' : s.status === 'waiting' && s.step_no === r.current_step ? 'p-warn' : 'p-mute'}`}
                            style={{ marginRight: 4 }}>
                            {s.required_role}
                          </span>
                        ))}
                      </td>
                      <td><span className={`pill ${STATE[r.status]}`}><span className="pd" />{r.status}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        {r.status === 'pending' && (
                          <form action={decideRequest} style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <input className="inp" name="note" placeholder="Why — the person sees this"
                                 style={{ flex: 1, minWidth: 150, padding: '6px 10px', fontSize: 12.5 }} />
                          <input type="hidden" name="id" value={r.id} />
                            <button className="btn btn-p" type="submit" name="decision" value="approve">Approve</button>
                            <button className="btn btn-g" type="submit" name="decision" value="reject">Reject</button>
                          </form>
                        )}
                      </td>
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
