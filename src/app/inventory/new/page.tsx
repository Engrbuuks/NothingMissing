import Shell from '@/components/Shell';
import { createStockItem } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default function NewStockItem({ searchParams }: { searchParams: { error?: string } }) {
  return (
    <Shell current="inventory" title="Add a stock item" subtitle="Consumables you count rather than track individually">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={createStockItem}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">What it is</div>
              <div className="card-s">
                Stock is anything fungible — one litre of diesel is interchangeable with any
                other. Anything with a serial belongs on the asset register instead.
              </div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="sku">SKU</label>
                <input className="inp mono" id="sku" name="sku" required placeholder="CON-AGO-001" />
              </div>
              <div>
                <label className="lbl" htmlFor="name">Name</label>
                <input className="inp" id="name" name="name" required placeholder="Diesel (AGO)" />
              </div>
              <div>
                <label className="lbl" htmlFor="category">Category</label>
                <input className="inp" id="category" name="category" placeholder="Fuel, Safety, Spares…" />
              </div>
            </div>

            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="unit">Counted in</label>
                <select className="inp" id="unit" name="unit">
                  <option value="litres">litres</option>
                  <option value="units">units</option>
                  <option value="kg">kilogrammes</option>
                  <option value="metres">metres</option>
                  <option value="rolls">rolls</option>
                  <option value="boxes">boxes</option>
                </select>
                <div className="hint">
                  Litres divide, helmets do not. This is what stops someone recording half a
                  helmet.
                </div>
              </div>
              <div>
                <label className="lbl" htmlFor="reorder">Reorder point</label>
                <input className="inp" id="reorder" name="reorder" type="number" step="any" min="0" defaultValue={0} />
                <div className="hint">Crossing it writes an audit row — the clock on a lead time starts there.</div>
              </div>
              <div>
                <label className="lbl" htmlFor="cost">Unit cost</label>
                <input className="inp" id="cost" name="cost" placeholder="e.g. 1,250" />
              </div>
            </div>

            <div>
              <label className="lbl" htmlFor="tolerance">Count tolerance</label>
              <input className="inp" id="tolerance" name="tolerance" type="number" step="0.1" min="0" max="100" defaultValue={0} style={{ maxWidth: 160 }} />
              <div className="hint">
                Percentage variance to treat as normal measurement error. A dipstick on a
                2,000 litre tank is not accurate to the litre; a count of helmets is. Leaving
                every item at zero floods the review queue with noise, and a queue that is
                always full gets ignored.
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/inventory">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>Add the item</button>
        </div>
      </form>
    </Shell>
  );
}
