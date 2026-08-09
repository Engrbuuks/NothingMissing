import Shell from '@/components/Shell';
import { getSession, sb, canSeeFinancials, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'In service', cls: 'p-ok' },
  transit: { label: 'In transit', cls: 'p-sky' },
  repair: { label: 'In repair', cls: 'p-warn' },
  idle: { label: 'Unassigned', cls: 'p-mute' },
  retired: { label: 'Retired', cls: 'p-bad' },
};

type Row = {
  id: string;
  tag: string;
  name: string;
  serial_no: string | null;
  status: keyof typeof STATUS;
  location_id: string | null;
  holder: string | null;
  acquired_on: string | null;
  locations: { name: string } | null;
  models: { name: string; brands: { name: string } | null } | null;
};

export default async function Assets() {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  // No company_id filter and no location filter in this query. That is
  // deliberate: row-level security applies both, so what comes back is already
  // scoped to this tenant and to the locations this person covers. Adding the
  // filters here would hide a mistake — if RLS were ever wrong, we would want
  // to see it rather than paper over it in the client.
  const { data, error } = await supabase
    .from('assets')
    .select(
      `id, tag, name, serial_no, status, location_id, holder, acquired_on,
       locations ( name ),
       models ( name, brands ( name ) )`
    )
    .order('tag')
    .limit(200);

  const rows = (data ?? []) as unknown as Row[];

  // Costs live in their own table behind their own policy. A location manager
  // asking for them gets an empty set rather than nulls, so there is nothing
  // to blank out in the UI.
  let costs = new Map<string, number>();
  if (showCost && rows.length) {
    const { data: fin } = await supabase
      .from('asset_financials')
      .select('asset_id, purchase_cost_minor')
      .in('asset_id', rows.map((r) => r.id));
    costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f.purchase_cost_minor]));
  }

  return (
    <Shell
      current="assets"
      title="Asset register"
      subtitle={`${rows.length} asset${rows.length === 1 ? '' : 's'} you can see`}
    >
      {error && (
        <div className="notice bad">
          <p>
            <b>The register could not be read.</b> {error.message}
            <br />
            If this says the relation does not exist, the migrations have not been applied to
            this project yet. Open <a href="/diagnostics" style={{ textDecoration: 'underline' }}>Diagnostics</a>.
          </p>
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="card">
          <div className="empty">
            <h4>Nothing on the register yet</h4>
            <p>
              Either no assets have been added to this company, or none sit at a location your
              role covers. Both look the same from here, which is the point — the database
              decides what you can see, not this page.
            </p>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">
                {rows.length} asset{rows.length === 1 ? '' : 's'}
              </div>
              <div className="card-s">
                {showCost
                  ? 'Purchase cost is visible to your role'
                  : 'Purchase cost is not visible to your role — the database did not send it'}
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Asset</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Assigned to</th>
                  {showCost && <th>Purchase cost</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = STATUS[a.status] ?? STATUS.idle;
                  return (
                    <tr key={a.id}>
                      <td>
                        <span className="tag">{a.tag}</span>
                      </td>
                      <td>
                        <div className="aname">{a.name}</div>
                        <div className="amake">
                          {a.models?.brands?.name ? `${a.models.brands.name} · ` : ''}
                          {a.models?.name ?? (a.serial_no ? `Serial ${a.serial_no}` : 'No catalog model')}
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>
                        {a.status === 'transit' ? 'In transit' : a.locations?.name ?? '—'}
                      </td>
                      <td>
                        <span className={`pill ${st.cls}`}>
                          <span className="pd" />
                          {st.label}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>{a.holder ?? '—'}</td>
                      {showCost && (
                        <td className="mono" style={{ fontSize: 12.5 }}>
                          {money(costs.get(a.id))}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Shell>
  );
}
