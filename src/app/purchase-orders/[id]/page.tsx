import Shell from '@/components/Shell';
import { sb, canSeeFinancials, canWrite, getSession, money } from '@/lib/session';
import { receiveGoods, cancelPurchaseOrder } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Goods receipt. The one place a system quietly manufactures fiction: "12
 * chairs arrived" becoming 12 identical rows nobody can ever tell apart.
 *
 * app.receive_goods() refuses a serialised line whose serial count does not
 * match its quantity. If the goods genuinely have no nameplate, the line must
 * be marked unserialised explicitly — a decision someone makes, not a gap the
 * system papers over.
 */
export default async function PurchaseOrder({
  params, searchParams,
}: { params: { id: string }; searchParams: { error?: string; received?: string } }) {
  const session = await getSession();
  const supabase = sb();

  if (!canSeeFinancials(session)) {
    return (
      <Shell current="purchase-orders" title="Purchase order" subtitle="Not available to your role">
        <div className="card"><div className="empty"><h4>Not available to your role</h4>
        <p>Purchase orders carry prices.</p></div></div>
      </Shell>
    );
  }

  const { data: po } = await supabase
    .from('purchase_orders')
    .select(`id, reference, status, expected_on, notes,
             suppliers ( name, email ), locations:destination ( name )`)
    .eq('id', params.id).maybeSingle();

  if (!po) {
    return (
      <Shell current="purchase-orders" title="Purchase order" subtitle="Not found">
        <div className="notice bad"><p>No order with that reference is visible to you.</p></div>
      </Shell>
    );
  }

  const p = po as any;

  const { data: lines } = await supabase
    .from('purchase_order_lines')
    .select('id, line_no, kind, description, qty, unit_cost_minor, unserialised, qty_received, models ( name )')
    .eq('po_id', params.id).order('line_no');

  const rows = (lines ?? []) as any[];
  const outstanding = rows.filter((l) => Number(l.qty_received) < Number(l.qty));
  const canReceive = p.status === 'issued' || p.status === 'part_received';
  const total = rows.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost_minor ?? 0), 0);

  return (
    <Shell current="purchase-orders" title={p.reference} subtitle={`${p.suppliers?.name ?? 'No supplier'} → ${p.locations?.name ?? ''}`}>
      <a className="btn btn-g" href="/purchase-orders" style={{ marginBottom: 18 }}>Back to orders</a>

      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.received && (
        <div className="notice"><p>Received. The assets are on the register with their serials, and the stock lines are in the ledger.</p></div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div><div className="card-t">Order lines</div>
          <div className="card-s">What each line becomes when the goods arrive</div></div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>#</th><th>Description</th><th>Becomes</th><th>Qty</th><th>Received</th><th>Unit</th><th>Total</th></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.line_no}</td>
                  <td><div className="aname">{l.description}</div></td>
                  <td>
                    {l.kind === 'asset'
                      ? <span className="pill p-sky"><span className="pd" />{l.qty} tracked asset{Number(l.qty) === 1 ? '' : 's'}</span>
                      : l.kind === 'stock'
                        ? <span className="pill p-mute"><span className="pd" />Stock</span>
                        : <span className="pill p-mute"><span className="pd" />Cost only</span>}
                  </td>
                  <td className="mono">{l.qty}</td>
                  <td className="mono">{l.qty_received}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{money(l.unit_cost_minor)}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{money(Number(l.qty) * Number(l.unit_cost_minor ?? 0))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={6} style={{ textAlign: 'right', fontWeight: 600, padding: 16 }}>Total</td>
              <td className="mono" style={{ fontWeight: 700, padding: 16 }}>{money(total)}</td></tr>
            </tfoot>
          </table>
        </div>
      </div>

      {canReceive && outstanding.length > 0 && (
        <form action={receiveGoods}>
          <input type="hidden" name="po" value={p.id} />
          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Capture serials</div>
                <div className="card-s">
                  One per unit. An asset without a serial cannot be scan-matched to the thing
                  in front of you, which means it can never be verified in the field.
                </div>
              </div>
            </div>

            {outstanding.filter((l) => l.kind === 'asset').map((l) => (
              <div key={l.id} style={{ borderBottom: '1px solid var(--line-2)', padding: '16px 20px' }}>
                <div className="aname" style={{ marginBottom: 4 }}>{l.description}</div>
                <div className="amake" style={{ marginBottom: 12 }}>
                  Line {l.line_no} · {l.qty} unit{Number(l.qty) === 1 ? '' : 's'}
                  {l.unserialised ? ' · marked as carrying no serial' : ''}
                </div>
                {!l.unserialised && (
                  <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))' }}>
                    {Array.from({ length: Number(l.qty) }).map((_, i) => (
                      <input
                        key={i}
                        className="inp"
                        name={`serial_${l.line_no}_${i}`}
                        placeholder={`Serial ${i + 1} of ${l.qty}`}
                        style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            <div style={{ padding: 20 }}>
              <input className="inp" name="note" placeholder="Anything worth recording about this delivery" />
              <div className="hint">
                A serialised line with the wrong number of serials is refused outright rather
                than creating rows you cannot tell apart later.
              </div>
              <div style={{ height: 14 }} />
              <button className="btn btn-p" type="submit">Receive the goods</button>
            </div>
          </div>
        </form>
      )}

      {p.status === 'received' && (
        <div className="notice"><p>This order is complete. The assets it created are on the register.</p></div>
      )}
      {p.status !== 'received' && p.status !== 'cancelled' && canWrite(session) && (
        <div className="card" style={{ borderColor: 'var(--bad-soft)' }}>
          <div className="card-h bd">
            <div>
              <div className="card-t" style={{ color: 'var(--bad)' }}>Cancel this order</div>
              <div className="card-s">
                It stays on the record with your reason — an order that simply vanishes
                answers nothing when somebody asks in six months
              </div>
            </div>
          </div>
          <form action={cancelPurchaseOrder}
                style={{ padding: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input type="hidden" name="id" value={p.id} />
            <input className="inp" name="reason" required minLength={3}
                   placeholder="Why — supplier could not deliver, no longer needed…"
                   style={{ flex: 1, minWidth: 220 }} />
            <button className="btn btn-g" type="submit"
                    style={{ color: 'var(--bad)', borderColor: 'var(--bad-soft)' }}>
              Cancel the order
            </button>
          </form>
        </div>
      )}
    </Shell>
  );
}
