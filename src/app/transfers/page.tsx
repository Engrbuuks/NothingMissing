import Shell from '@/components/Shell';
import { deleteTransferDraft } from '@/lib/actions';
import { sb, getSession, canWrite } from '@/lib/session';

export const dynamic = 'force-dynamic';

const STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'p-mute' },
  pending: { label: 'Awaiting approval', cls: 'p-warn' },
  approved: { label: 'Approved, not dispatched', cls: 'p-sky' },
  in_transit: { label: 'In transit', cls: 'p-sky' },
  received: { label: 'Received', cls: 'p-ok' },
  cancelled: { label: 'Cancelled', cls: 'p-mute' },
  rejected: { label: 'Rejected', cls: 'p-bad' },
};

type Row = {
  id: string;
  reference: string;
  status: keyof typeof STATE;
  waybill_no: string | null;
  dispatched_at: string | null;
  from: { name: string } | null;
  to: { name: string } | null;
  transfer_lines: { count: number }[];
};

const days = (iso: string | null) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

export default async function Transfers({
  searchParams,
}: { searchParams: { q?: string; status?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const q = (searchParams.q ?? '').trim();
  const fstatus = searchParams.status ?? 'all';

  // RLS returns only transfers where this person can act at one end or the
  // other, so there is no company or location filter here.
  let query = supabase
    .from('transfers')
    .select(
      `id, reference, status, waybill_no, dispatched_at,
       from:from_location ( name ),
       to:to_location ( name ),
       transfer_lines ( count )`
    )
    .order('created_at', { ascending: false })
    .limit(200);

  if (fstatus !== 'all') query = query.eq('status', fstatus);
  if (q) query = query.or(`reference.ilike.%${q}%,waybill_no.ilike.%${q}%,driver_name.ilike.%${q}%,vehicle_reg.ilike.%${q}%`);

  const { data, error } = await query;

  const rows = (data ?? []) as unknown as Row[];
  const moving = rows.filter((r) => r.status === 'in_transit');
  const rest = rows.filter((r) => r.status !== 'in_transit');

  return (
    <Shell
      current="transfers"
      title="Transfers"
      subtitle="Assets moving between registers"
    >
      <form className="toolbar" method="get" action="/transfers">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search waybill, reference, driver or vehicle" />
        </div>
        <select className="sel" name="status" defaultValue={fstatus}>
          <option value="all">Any status</option>
          {Object.entries(STATE).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <button className="btn btn-g" type="submit">Apply</button>
        {(q || fstatus !== 'all') && <a className="btn btn-g" href="/transfers">Clear</a>}
        <a className="btn btn-p" href="/transfers/new" style={{ marginLeft: 'auto' }}>New transfer</a>
      </form>

      {error && (
        <div className="notice bad">
          <p>{error.message}</p>
        </div>
      )}

      {moving.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">In transit · {moving.length}</div>
              <div className="card-s">
                These assets belong to neither register until someone at the destination
                confirms they arrived
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Waybill</th>
                  <th>Route</th>
                  <th>Assets</th>
                  <th>Days out</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {moving.map((t) => {
                  const d = days(t.dispatched_at);
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="tag">{t.waybill_no ?? t.reference}</span>
                      </td>
                      <td>
                        {t.from?.name ?? '—'} → <b>{t.to?.name ?? '—'}</b>
                      </td>
                      <td className="mono">{t.transfer_lines?.[0]?.count ?? 0}</td>
                      <td>
                        <span className={`pill ${d !== null && d > 3 ? 'p-bad' : 'p-sky'}`}>
                          <span className="pd" />
                          {d === null ? '—' : `${d} day${d === 1 ? '' : 's'}`}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <a className="btn btn-p" href={`/transfers/${t.id}`}>
                          Receive
                        </a>
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
            <div className="card-t">
              {rest.length} other transfer{rest.length === 1 ? '' : 's'}
            </div>
            <div className="card-s">Drafts, approvals and completed movements</div>
          </div>
        </div>
        {rest.length === 0 ? (
          <div className="empty">
            <h4>Nothing here yet</h4>
            <p>
              A transfer moves assets from one location to another. Nothing leaves the
              origin register until it is dispatched, and nothing joins the destination
              until someone there confirms it arrived.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Route</th>
                  <th>Assets</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rest.map((t) => {
                  const st = STATE[t.status] ?? STATE.draft;
                  return (
                    <tr key={t.id}>
                      <td>
                        <span className="tag">{t.waybill_no ?? t.reference}</span>
                      </td>
                      <td>
                        {t.from?.name ?? '—'} → {t.to?.name ?? '—'}
                      </td>
                      <td className="mono">{t.transfer_lines?.[0]?.count ?? 0}</td>
                      <td>
                        <span className={`pill ${st.cls}`}>
                          <span className="pd" />
                          {st.label}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <a className="btn btn-g" href={`/transfers/${t.id}`}>Open</a>
                          {/* Only a draft. Once approved or dispatched it is a
                              document, and documents are cancelled rather than
                              deleted — the database enforces that too. */}
                          {t.status === 'draft' && canWrite(session) && (
                            <form action={deleteTransferDraft.bind(null, t.id)}>
                              <button className="btn btn-g" type="submit"
                                      style={{ color: 'var(--bad)' }}>Delete</button>
                            </form>
                          )}
                        </div>
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
