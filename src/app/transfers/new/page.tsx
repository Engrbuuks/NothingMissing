import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { createTransfer } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function NewTransfer({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const supabase = sb();

  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, kind')
    .is('archived_at', null)
    .order('name');

  // Only assets actually on a register can move. Anything already in transit
  // or retired is excluded here, and dispatch_transfer() re-checks it anyway —
  // between drafting and dispatching, something may have moved.
  const { data: assets } = await supabase
    .from('assets')
    .select('id, tag, name, location_id, status, locations ( name )')
    .eq('status', 'active')
    .order('tag')
    .limit(300);

  const locs = locations ?? [];
  const list = (assets ?? []) as any[];

  return (
    <Shell current="transfers" title="New transfer" subtitle="Move assets between registers">
      {searchParams.error && (
        <div className="notice bad">
          <p>{searchParams.error}</p>
        </div>
      )}

      <form action={createTransfer}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Where it is going</div>
              <div className="card-s">Both ends must be locations you can act at</div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <label className="lbl" htmlFor="from">From</label>
              <select className="inp" id="from" name="from" required>
                {locs.map((l: any) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="to">To</label>
              <select className="inp" id="to" name="to" required>
                {locs.map((l: any) => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.kind === 'virtual' ? ' (virtual warehouse)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="driver">Driver</label>
              <input className="inp" id="driver" name="driver" placeholder="Who is carrying it" />
            </div>
            <div>
              <label className="lbl" htmlFor="plate">Vehicle registration</label>
              <input className="inp" id="plate" name="plate" placeholder="e.g. LND-472-XA" />
              <div className="hint">Optional, but it is what makes a waybill useful at a checkpoint.</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="lbl" htmlFor="reason">Reason</label>
              <input className="inp" id="reason" name="reason" placeholder="Redeployment, new site setup, returning to store…" />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">What is moving</div>
              <div className="card-s">
                Only assets currently in service can be moved. Anything already in transit or
                retired is not listed.
              </div>
            </div>
          </div>
          {list.length === 0 ? (
            <div className="empty">
              <h4>No assets available to move</h4>
              <p>Every asset you can see is either already in transit, out for repair, or retired.</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 48 }} />
                    <th>Tag</th>
                    <th>Asset</th>
                    <th>Currently at</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        <input type="checkbox" name="asset" value={a.id} />
                      </td>
                      <td><span className="tag">{a.tag}</span></td>
                      <td><div className="aname">{a.name}</div></td>
                      <td style={{ color: 'var(--text-2)' }}>{a.locations?.name ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/transfers">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>
            Create transfer
          </button>
        </div>
      </form>
    </Shell>
  );
}
