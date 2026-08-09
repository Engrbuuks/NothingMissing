import Shell from '@/components/Shell';
import { sb, canSeeFinancials, getSession, money } from '@/lib/session';
import { issueStock, transferStock, receiveStock } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Inventory({ searchParams }: { searchParams: { error?: string; done?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const { data: items, error } = await supabase
    .from('stock_items')
    .select('id, sku, name, unit, reorder_point, unit_cost_minor, is_divisible')
    .is('archived_at', null)
    .order('sku');

  const { data: balances } = await supabase
    .from('stock_balances')
    .select('item_id, location_id, qty');

  const { data: locations } = await supabase
    .from('locations').select('id, name').is('archived_at', null).order('name');

  const list = items ?? [];
  const bal = balances ?? [];
  const locs = locations ?? [];

  const totalFor = (id: string) =>
    bal.filter((b: any) => b.item_id === id).reduce((s: number, b: any) => s + Number(b.qty), 0);

  const low = list.filter((i: any) => totalFor(i.id) < Number(i.reorder_point)).length;

  return (
    <Shell current="inventory" title="Inventory" subtitle="Consumable stock, counted rather than serialised">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.done && (
        <div className="notice"><p>Done. The ledger has a new row; the balance is derived from it.</p></div>
      )}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {low > 0 && (
        <div className="notice warn">
          <p><b>{low} item{low === 1 ? '' : 's'} below the reorder point.</b> Ordering has a lead time — the clock starts now, not when it runs out.</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{list.length} stock item{list.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              Quantities are the sum of an append-only ledger, never a number anyone typed
            </div>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="empty">
            <h4>No stock items yet</h4>
            <p>
              Stock is the fungible half: fuel, spares, PPE. It is counted, not tracked
              individually, which is why it lives apart from the asset register.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th><th>Item</th><th>On hand</th><th>Reorder at</th><th>Status</th>
                  {showCost && <th>Value</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((i: any) => {
                  const q = totalFor(i.id);
                  const state = q === 0 ? 'p-bad' : q < Number(i.reorder_point) ? 'p-warn' : 'p-ok';
                  const label = q === 0 ? 'Out of stock' : q < Number(i.reorder_point) ? 'Below reorder' : 'In stock';
                  return (
                    <tr key={i.id}>
                      <td><span className="tag">{i.sku}</span></td>
                      <td><div className="aname">{i.name}</div><div className="amake">{i.unit}</div></td>
                      <td className="mono" style={{ fontWeight: 600 }}>{q.toLocaleString()} <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{i.unit}</span></td>
                      <td className="mono" style={{ color: 'var(--text-3)' }}>{Number(i.reorder_point).toLocaleString()}</td>
                      <td><span className={`pill ${state}`}><span className="pd" />{label}</span></td>
                      {showCost && <td className="mono" style={{ fontSize: 12.5 }}>{money(q * Number(i.unit_cost_minor ?? 0))}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {list.length > 0 && locs.length > 0 && (
        <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
          <form action={receiveStock} className="card">
            <div className="card-h bd"><div><div className="card-t">Receive</div><div className="card-s">Goods arriving</div></div></div>
            <div style={{ padding: 18, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>{list.map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
              <select className="inp" name="location" required>{locs.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              <input className="inp" name="qty" type="number" step="any" min="0.001" placeholder="Quantity" required />
              <input className="inp" name="reason" placeholder="Reference or note" />
              <button className="btn btn-p" type="submit">Receive</button>
            </div>
          </form>

          <form action={issueStock} className="card">
            <div className="card-h bd"><div><div className="card-t">Issue and consume</div><div className="card-s">Drawn for a job or an asset</div></div></div>
            <div style={{ padding: 18, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>{list.map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
              <select className="inp" name="location" required>{locs.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
              <input className="inp" name="qty" type="number" step="any" min="0.001" placeholder="Quantity" required />
              <input className="inp" name="job" placeholder="Job, asset tag or cost centre" />
              <button className="btn btn-p" type="submit">Issue</button>
              <div className="hint">Issuing to a generator with a meter reading is what makes fuel reconciliation possible later.</div>
            </div>
          </form>

          <form action={transferStock} className="card">
            <div className="card-h bd"><div><div className="card-t">Move between sites</div><div className="card-s">Both legs or neither</div></div></div>
            <div style={{ padding: 18, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>{list.map((i: any) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
              <select className="inp" name="from" required>{locs.map((l: any) => <option key={l.id} value={l.id}>From {l.name}</option>)}</select>
              <select className="inp" name="to" required>{locs.map((l: any) => <option key={l.id} value={l.id}>To {l.name}</option>)}</select>
              <input className="inp" name="qty" type="number" step="any" min="0.001" placeholder="Quantity" required />
              <button className="btn btn-p" type="submit">Move stock</button>
            </div>
          </form>
        </div>
      )}
    </Shell>
  );
}
