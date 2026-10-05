import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { createTransfer } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function NewTransfer({
  searchParams,
}: {
  searchParams: { error?: string; from?: string };
}) {
  const supabase = sb();

  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, kind')
    .is('archived_at', null)
    .order('name');

  const locs = locations ?? [];
  // The origin has to be settled before anything can be listed, because what
  // is movable depends entirely on where you are moving it from. The old page
  // listed every asset in the company and left you to find the right ones.
  const from = searchParams.from ?? '';

  // Identical things, collapsed, with anything already on an open manifest
  // excluded. Individual tags come separately so a row can be expanded when it
  // has to be that particular machine.
  const [{ data: groupRows }, { data: assetRows }] = from
    ? await Promise.all([
        supabase.rpc('asset_groups', { p_location: from }),
        supabase
          .from('assets')
          .select('id, tag, name, model_id, serial_no')
          .eq('location_id', from)
          .eq('status', 'active')
          .order('tag')
          .limit(1000),
      ])
    : [{ data: null }, { data: null }];

  const groups = (groupRows ?? []) as any[];
  const assets = (assetRows ?? []) as any[];
  const keyOf = (a: any) => `${a.name}|${a.model_id ?? ''}`;
  const unitsIn = (key: string) => assets.filter((a) => keyOf(a) === key);

  const fromName = locs.find((l: any) => l.id === from)?.name;

  return (
    <Shell current="transfers" title="New transfer" subtitle="Move assets between registers">
      {searchParams.error && (
        <div className="notice bad">
          <p>{searchParams.error}</p>
        </div>
      )}

      {/* Step one is its own GET form so the page can reload with the origin's
          stock. A plain form rather than a script, so it works on the warehouse
          phone with a bad connection that never finishes loading JavaScript. */}
      <form method="get" className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Where it is coming from</div>
            <div className="card-s">Pick the origin first — what you can move depends on it</div>
          </div>
        </div>
        <div style={{ padding: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <label className="lbl" htmlFor="from-pick">From</label>
            <select className="inp" id="from-pick" name="from" defaultValue={from}>
              <option value="">Choose a location…</option>
              {locs.map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.kind === 'virtual' ? ' (virtual warehouse)' : ''}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-g" type="submit">Show what is there</button>
        </div>
      </form>

      {!from ? (
        <div className="empty">
          <h4>Choose an origin</h4>
          <p>Once you pick where the assets are leaving from, everything there is listed in groups.</p>
        </div>
      ) : (
        <form action={createTransfer}>
          <input type="hidden" name="from" value={from} />

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-h bd">
              <div>
                <div className="card-t">Where it is going</div>
                <div className="card-s">Both ends must be locations you can act at</div>
              </div>
            </div>
            <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr' }}>
              <div>
                <label className="lbl" htmlFor="to">To</label>
                <select className="inp" id="to" name="to" required>
                  {locs.filter((l: any) => l.id !== from).map((l: any) => (
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
              <div>
                <label className="lbl" htmlFor="reason">Reason</label>
                <input className="inp" id="reason" name="reason" placeholder="Redeployment, new site setup…" />
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-h bd">
              <div>
                <div className="card-t">How many of what</div>
                <div className="card-s">
                  Type the number against each line. Identical things are grouped, so twelve
                  chairs is one number rather than twelve ticks. Anything already on an open
                  transfer is left out of the count.
                </div>
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="empty">
                <h4>Nothing available at {fromName}</h4>
                <p>
                  Everything here is already in transit, out for repair, retired, or on another
                  open transfer.
                </p>
              </div>
            ) : (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>What</th>
                      <th style={{ width: 110 }}>Available</th>
                      <th style={{ width: 130 }}>Move how many</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g: any) => (
                      <tr key={g.group_key}>
                        <td>
                          {/* The key travels with the row. The action reads the
                              two lists in step, which HTML form serialisation
                              guarantees because it is document order. */}
                          <input type="hidden" name="group" value={g.group_key} />
                          <div className="aname">{g.name}</div>
                          <div className="amake">
                            {[g.brand_name, g.model_name].filter(Boolean).join(' ') || g.category || '—'}
                            {Number(g.with_serial) > 0 && ` · ${g.with_serial} with serials`}
                          </div>

                          {/* When it has to be THAT one. Ticking here is additive
                              to the quantity above it, so "that generator plus
                              three more" is one submission. */}
                          {Number(g.available) > 1 && (
                            <details style={{ marginTop: 6 }}>
                              <summary className="hint" style={{ cursor: 'pointer' }}>
                                Pick particular ones instead
                              </summary>
                              <div className="tagsheet" style={{ padding: '10px 0 0', background: 'none' }}>
                                {unitsIn(g.group_key).map((a: any) => (
                                  <label key={a.id} className="chk" style={{ padding: '7px 9px' }}>
                                    <input type="checkbox" name="asset" value={a.id} />
                                    <span>
                                      <b className="mono" style={{ fontSize: 12 }}>{a.tag}</b>
                                      {a.serial_no && (
                                        <span className="hint" style={{ marginTop: 1 }}>{a.serial_no}</span>
                                      )}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            </details>
                          )}
                        </td>
                        <td className="mono" style={{ color: 'var(--text-2)' }}>{g.available}</td>
                        <td>
                          <input
                            className="inp mono"
                            name="qty"
                            type="number"
                            min={0}
                            max={Number(g.available)}
                            step={1}
                            defaultValue={0}
                            aria-label={`How many ${g.name} to move`}
                            style={{ width: 90, textAlign: 'right' }}
                          />
                        </td>
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
      )}
    </Shell>
  );
}
