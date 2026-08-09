import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { raiseRequest } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Raising a request. Nothing here decides who approves it — app.match_policy()
 * reads the amount and item count against the company's policy rows and builds
 * the chain. Company A wanting one approver under NGN 500,000 and two above it
 * is two rows, not a deployment.
 */
export default async function NewRequest({
  searchParams,
}: { searchParams: { error?: string; kind?: string } }) {
  const supabase = sb();

  const { data: locations } = await supabase
    .from('locations').select('id, name').is('archived_at', null).order('name');

  const { data: assets } = await supabase
    .from('assets').select('id, tag, name').neq('status', 'retired').order('tag').limit(300);

  const { data: policies } = await supabase
    .from('approval_policies')
    .select('request_type, name, chain, min_amount_minor, max_amount_minor, min_items, max_items')
    .eq('active', true).order('priority');

  return (
    <Shell current="requests" title="Raise a request" subtitle="Repairs, purchases and disposals">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={raiseRequest}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div><div className="card-t">What are you asking for</div>
            <div className="card-s">The approval chain is chosen from your company&rsquo;s policies, not from this form</div></div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="kind">Kind</label>
                <select className="inp" id="kind" name="kind" defaultValue={searchParams.kind ?? 'repair'}>
                  <option value="repair">Repair</option>
                  <option value="purchase">Purchase</option>
                  <option value="disposal">Disposal</option>
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="location">Location</label>
                <select className="inp" id="location" name="location" required>
                  {(locations ?? []).map((l: any) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="lbl" htmlFor="title">In one line</label>
              <input className="inp" id="title" name="title" required placeholder="e.g. Gearbox overhaul on the Hiace" />
            </div>

            <div>
              <label className="lbl" htmlFor="detail">Detail</label>
              <input className="inp" id="detail" name="detail" placeholder="What is wrong, what you propose, why now" />
            </div>

            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="asset">Which asset, if any</label>
                <select className="inp" id="asset" name="asset">
                  <option value="">Not about a specific asset</option>
                  {(assets ?? []).map((a: any) => (
                    <option key={a.id} value={a.id}>{a.tag} — {a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="amount">Estimated cost</label>
                <input className="inp" id="amount" name="amount" placeholder="e.g. 1,450,000" />
                <div className="hint">This is what decides how many approvals it needs.</div>
              </div>
              <div>
                <label className="lbl" htmlFor="items">How many items</label>
                <input className="inp" id="items" name="items" type="number" min="1" defaultValue={1} />
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div><div className="card-t">Your company&rsquo;s approval policies</div>
            <div className="card-s">Evaluated in order; the first one that matches wins</div></div>
          </div>
          {(policies ?? []).length === 0 ? (
            <div className="empty">
              <h4>No policies configured</h4>
              <p>
                A request matching no policy falls through to a single location-manager
                approval, so a gap in configuration never becomes a gap in oversight.
              </p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Applies to</th><th>Rule</th><th>When</th><th>Chain</th></tr></thead>
                <tbody>
                  {(policies ?? []).map((p: any, i: number) => (
                    <tr key={i}>
                      <td><span className="pill p-mute"><span className="pd" />{p.request_type}</span></td>
                      <td><div className="aname">{p.name}</div></td>
                      <td style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
                        {p.min_amount_minor ? `from ₦${(p.min_amount_minor / 100).toLocaleString()}` : ''}
                        {p.max_amount_minor ? ` up to ₦${(p.max_amount_minor / 100).toLocaleString()}` : ''}
                        {p.min_items ? `${p.min_items} items or more` : ''}
                        {p.max_items ? ` under ${p.max_items} items` : ''}
                        {!p.min_amount_minor && !p.max_amount_minor && !p.min_items && !p.max_items ? 'any' : ''}
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{(p.chain ?? []).join(' → ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/requests">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>Raise it</button>
        </div>
      </form>
    </Shell>
  );
}
