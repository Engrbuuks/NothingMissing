import Shell from '@/components/Shell';
import { sb, canSeeFinancials, getSession, canWrite } from '@/lib/session';
import { createSupplier, deleteSupplier, archiveSupplier } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Suppliers({
  searchParams,
}: { searchParams: { error?: string; added?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: suppliers, error } = await supabase
    .from('suppliers')
    .select('id, name, email, phone, supplies')
    .is('archived_at', null)
    .order('name');

  const list = (suppliers ?? []) as any[];

  // Lead time is measured from your own orders, not from what the supplier
  // said. That is how you find out the one promising two weeks has averaged
  // three for a year.
  const lead = new Map<string, any>();
  for (const s of list) {
    const { data } = await supabase.rpc('supplier_lead_time', { p_supplier: s.id });
    if (data) lead.set(s.id, data);
  }

  return (
    <Shell current="suppliers" title="Suppliers" subtitle="Who you buy from, and how they actually perform">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.added && <div className="notice"><p>Supplier added.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div><div className="card-t">Add a supplier</div><div className="card-s">Purchase orders route to these</div></div>
        </div>
        <form action={createSupplier} style={{ padding: 20, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
          <div><label className="lbl" htmlFor="name">Name</label><input className="inp" id="name" name="name" required /></div>
          <div><label className="lbl" htmlFor="email">Email</label><input className="inp" id="email" name="email" type="email" /></div>
          <div><label className="lbl" htmlFor="phone">Phone</label><input className="inp" id="phone" name="phone" /></div>
          <div><label className="lbl" htmlFor="supplies">Supplies</label><input className="inp" id="supplies" name="supplies" placeholder="IT equipment, generators…" /></div>
          <div style={{ gridColumn: '1 / -1' }}><button className="btn btn-p" type="submit">Add supplier</button></div>
        </form>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{list.length} supplier{list.length === 1 ? '' : 's'}</div>
            <div className="card-s">Lead time is computed from issue and receipt timestamps, not from a promise</div>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="empty"><h4>No suppliers yet</h4><p>Add the companies you buy from, and their lead times build themselves as orders complete.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Supplier</th><th>Supplies</th><th>Orders</th><th>Average lead time</th><th>Worst</th></tr></thead>
              <tbody>
                {list.map((s) => {
                  const l = lead.get(s.id);
                  return (
                    <tr key={s.id}>
                      <td><div className="aname">{s.name}</div><div className="amake">{s.email ?? s.phone ?? '—'}</div></td>
                      <td style={{ color: 'var(--text-2)' }}>{s.supplies ?? '—'}</td>
                      <td className="mono">{l?.orders ?? 0}</td>
                      <td className="mono">{l?.avg_days ? `${l.avg_days} days` : '—'}</td>
                      <td className="mono" style={{ color: 'var(--text-3)' }}>{l?.worst_days ? `${l.worst_days} days` : '—'}</td>
                      {canWrite(session) && (
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <form action={archiveSupplier.bind(null, s.id)}>
                              <button className="btn btn-g" type="submit"
                                      style={{ padding: '5px 10px', fontSize: 12 }}>Archive</button>
                            </form>
                            <form action={deleteSupplier.bind(null, s.id)}>
                              <button className="btn btn-g" type="submit"
                                      style={{ padding: '5px 10px', fontSize: 12, color: 'var(--bad)' }}>
                                Delete
                              </button>
                            </form>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!canSeeFinancials(session) && (
          <p className="hint" style={{ padding: '14px 20px' }}>
            Purchase orders and their prices are not visible to your role, so lead times
            here will read as zero.
          </p>
        )}
      </div>
    </Shell>
  );
}
