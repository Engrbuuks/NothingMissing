import Shell from '@/components/Shell';
import { sb } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Locations() {
  const supabase = sb();

  const { data, error } = await supabase
    .from('locations')
    .select('id, name, kind, city, archived_at')
    .order('name');

  const { data: assets } = await supabase.from('assets').select('location_id, status');
  const count = (id: string) =>
    (assets ?? []).filter((a: any) => a.location_id === id && a.status !== 'retired').length;

  const rows = (data ?? []) as any[];

  return (
    <Shell current="locations" title="Locations" subtitle="Branches, depots, sites, and the virtual warehouse">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="notice">
        <p>
          Locations archive, they never delete. Waybills, asset histories and audit rows
          all reference a location by id — dropping the row would turn every one of those
          into a dangling reference and quietly break the trail you keep this system for.
        </p>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.filter((l) => !l.archived_at).length} live</div>
            <div className="card-s">A virtual warehouse is a location with no address — same transfers, same waybills</div>
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Location</th><th>Type</th><th>Assets</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id} style={l.archived_at ? { opacity: 0.55 } : undefined}>
                  <td><div className="aname">{l.name}</div><div className="amake">{l.city ?? ''}</div></td>
                  <td>
                    <span className={`pill ${l.kind === 'virtual' ? 'p-mute' : 'p-sky'}`}>
                      {l.kind === 'virtual' ? 'Virtual' : 'Physical'}
                    </span>
                  </td>
                  <td className="mono">{count(l.id)}</td>
                  <td>
                    <span className={`pill ${l.archived_at ? 'p-mute' : 'p-ok'}`}>
                      <span className="pd" />{l.archived_at ? 'Archived' : 'Live'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Shell>
  );
}
