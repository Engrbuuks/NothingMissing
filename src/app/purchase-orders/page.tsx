import Shell from '@/components/Shell';
import { sb, canSeeFinancials, getSession, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'p-mute' },
  issued: { label: 'Awaiting delivery', cls: 'p-warn' },
  part_received: { label: 'Partly received', cls: 'p-warn' },
  received: { label: 'Received', cls: 'p-ok' },
  cancelled: { label: 'Cancelled', cls: 'p-mute' },
};

export default async function PurchaseOrders() {
  const session = await getSession();

  if (!canSeeFinancials(session)) {
    return (
      <Shell current="purchase-orders" title="Purchase orders" subtitle="Ordering and goods receipt">
        <div className="card">
          <div className="empty">
            <h4>Not available to your role</h4>
            <p>Purchase orders carry prices, so they sit behind the same permission as asset costs.</p>
          </div>
        </div>
      </Shell>
    );
  }

  const { data, error } = await sb()
    .from('purchase_orders')
    .select(`id, reference, status, expected_on, issued_at,
             suppliers ( name ), locations:destination ( name ),
             purchase_order_lines ( count )`)
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as any[];

  return (
    <Shell current="purchase-orders" title="Purchase orders" subtitle="Ordering, and where a purchase becomes real assets">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} order{rows.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              Receiving is where a purchase becomes assets on the register — with a serial
              each, or an explicit note that the goods carry none
            </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>No purchase orders yet</h4>
            <p>
              An approved purchase request becomes an order here. Receiving it creates the
              assets, adds the stock, and closes the order in one step.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Supplier</th><th>Deliver to</th><th>Lines</th><th>Expected</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const st = STATUS[p.status] ?? STATUS.draft;
                  return (
                    <tr key={p.id}>
                      <td><span className="tag">{p.reference}</span></td>
                      <td>{p.suppliers?.name ?? '—'}</td>
                      <td style={{ color: 'var(--text-2)' }}>{p.locations?.name ?? '—'}</td>
                      <td className="mono">{p.purchase_order_lines?.[0]?.count ?? 0}</td>
                      <td style={{ color: 'var(--text-2)' }}>{p.expected_on ?? '—'}</td>
                      <td><span className={`pill ${st.cls}`}><span className="pd" />{st.label}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <a className="btn btn-g" href={`/purchase-orders/${p.id}`}>Open</a>
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
