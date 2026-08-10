import Shell from '@/components/Shell';
import { sb, getSession, hasRole, canSeeFinancials, money } from '@/lib/session';
import { createLocation, archiveLocation, sweepLocation } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Locations({
  searchParams,
}: { searchParams: { error?: string; added?: string; swept?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const admin = hasRole(session, 'owner', 'admin');

  const [{ data: locs, error }, { data: assets }, { data: bals }] = await Promise.all([
    supabase.from('locations').select('id, name, kind, city, colour_hex, archived_at').order('name'),
    supabase.from('assets').select('id, location_id, status'),
    supabase.from('stock_balances').select('location_id, qty'),
  ]);

  const list = (locs ?? []) as any[];
  const live = list.filter((l) => !l.archived_at);
  const archived = list.filter((l) => l.archived_at);
  const assetList = (assets ?? []) as any[];

  const held = (id: string) => assetList.filter((a) => a.location_id === id && a.status !== 'retired').length;
  const stockLines = (id: string) => (bals ?? []).filter((b: any) => b.location_id === id && Number(b.qty) > 0).length;

  return (
    <Shell current="locations" title="Locations" subtitle={`${live.length} live site${live.length === 1 ? '' : 's'}`}>
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.added && <div className="notice"><p>Location added.</p></div>}
      {searchParams.swept && <div className="notice"><p>Swept. Everything moved to the virtual warehouse.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{live.length} location{live.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              Locations archive rather than delete — waybills and audit rows reference them by
              id, and dropping one turns every reference into a dangling pointer
            </div>
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Location</th><th>City</th><th>Assets held</th><th>Stock lines</th><th>Kind</th>{admin && <th />}</tr>
            </thead>
            <tbody>
              {live.map((l) => {
                const n = held(l.id);
                return (
                  <tr key={l.id}>
                    <td>
                      <span className="loc">
                        <span className="lic" style={{ background: l.colour_hex ?? '#9296AC' }} />
                        <b>{l.name}</b>
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-2)' }}>{l.city ?? '—'}</td>
                    <td className="mono">{n}</td>
                    <td className="mono" style={{ color: 'var(--text-2)' }}>{stockLines(l.id)}</td>
                    <td>
                      <span className={`pill ${l.kind === 'virtual' ? 'p-mute' : 'p-ok'}`}>
                        <span className="pd" />{l.kind === 'virtual' ? 'Virtual warehouse' : 'Physical site'}
                      </span>
                    </td>
                    {admin && (
                      <td style={{ textAlign: 'right' }}>
                        {l.kind === 'virtual' ? (
                          <span className="hint">Cannot be archived</span>
                        ) : n > 0 ? (
                          <form action={sweepLocation.bind(null, l.id)}>
                            <button className="btn btn-g" type="submit">Sweep {n} to virtual</button>
                          </form>
                        ) : (
                          <form action={archiveLocation.bind(null, l.id)}>
                            <button className="btn btn-g" type="submit">Archive</button>
                          </form>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {admin && (
          <form action={createLocation} style={{ padding: 20, borderTop: '1px solid var(--line-2)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input className="inp" name="name" placeholder="New location name" required style={{ flex: 1, minWidth: 180 }} />
            <input className="inp" name="city" placeholder="City" style={{ width: 180 }} />
            <button className="btn btn-p" type="submit">Add location</button>
          </form>
        )}
      </div>

      {archived.length > 0 && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Archived · {archived.length}</div>
              <div className="card-s">
                Hidden from pickers and reports, but still resolving in history — an old
                waybill still reads correctly
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Location</th><th>City</th><th>Archived</th></tr></thead>
              <tbody>
                {archived.map((l) => (
                  <tr key={l.id}>
                    <td style={{ color: 'var(--text-2)' }}>{l.name}</td>
                    <td style={{ color: 'var(--text-3)' }}>{l.city ?? '—'}</td>
                    <td style={{ color: 'var(--text-3)' }}>{new Date(l.archived_at).toLocaleDateString('en-GB')}</td>
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
