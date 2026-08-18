import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { raisePurchaseOrder } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Raising a purchase order.
 *
 * There was no way to create one. The table, the lines, the statuses and
 * receive_goods() all existed since 0009, and the screen listed orders that
 * could never come into being.
 *
 * Six blank lines rather than a button that adds them: a form that needs
 * JavaScript to grow is a form that breaks on a bad connection in a yard, and
 * most orders are shorter than six lines anyway.
 */
export default async function NewPurchaseOrder({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  const supabase = sb();

  if (!hasRole(session, 'owner', 'admin', 'manager')) {
    return (
      <Shell current="purchase-orders" title="Raise an order" subtitle="">
        <div className="card"><div className="empty">
          <h4>Your role cannot raise a purchase order</h4>
          <p>
            A requester can raise a <a href="/requests/new" style={{ textDecoration: 'underline' }}>request</a>{' '}
            for something to be bought. Turning that into an order is a manager&rsquo;s job.
          </p>
        </div></div>
      </Shell>
    );
  }

  const [{ data: suppliers }, { data: locations }, { data: models }, { data: items }, { data: co }] =
    await Promise.all([
      supabase.from('suppliers').select('id, name').is('archived_at', null).order('name'),
      supabase.from('locations').select('id, name').is('archived_at', null).order('name'),
      supabase.from('models').select('id, name, brands ( name )').order('name'),
      supabase.from('stock_items').select('id, sku, name, unit').is('archived_at', null).order('sku'),
      supabase.from('companies').select('id').limit(1).maybeSingle(),
    ]);

  // What this will need in signatures, shown before they raise it rather than
  // discovered afterwards.
  const { data: chain } = co
    ? await supabase.rpc('which_chain', {
        p_company: (co as any).id, p_type: 'purchase', p_amount_minor: null, p_items: null,
      })
    : { data: null };
  const ch = (chain ?? {}) as any;

  const rows = [0, 1, 2, 3, 4, 5];

  return (
    <Shell current="purchase-orders" title="Raise a purchase order" subtitle="Draft first — nothing is sent until you issue it">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      {ch.found && (
        <div className="notice">
          <p>
            <b>This will need {ch.signatures} signature{ch.signatures === 1 ? '' : 's'}:</b>{' '}
            {(ch.chain ?? []).join(', then ')}. That comes from your rule
            &ldquo;{ch.name}&rdquo; — <a href="/approvals" style={{ textDecoration: 'underline' }}>change who approves what</a>.
          </p>
        </div>
      )}

      <form action={raisePurchaseOrder}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Who and where</div>
              <div className="card-s">Where the goods are going decides which register they join</div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="supplier">Supplier</label>
              <select className="inp" id="supplier" name="supplier" defaultValue="">
                <option value="">Not decided yet</option>
                {(suppliers ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {(suppliers ?? []).length === 0 && (
                <div className="hint">
                  None on file — <a href="/suppliers" style={{ textDecoration: 'underline' }}>add one</a>.
                  Lead times are measured against them.
                </div>
              )}
            </div>
            <div>
              <label className="lbl" htmlFor="destination">Deliver to</label>
              <select className="inp" id="destination" name="destination" required>
                {(locations ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="expected">Expected on</label>
              <input className="inp" id="expected" name="expected" type="date" />
              <div className="hint">Used to flag it as overdue.</div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">What you are buying</div>
              <div className="card-s">
                Naming a catalog model makes each unit an asset with a tag on arrival.
                Naming a stock item makes it a balance. Neither means it is a service —
                labour, transport, a callout.
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 200 }}>Catalog model</th>
                  <th style={{ width: 180 }}>…or stock item</th>
                  <th>Description</th>
                  <th style={{ width: 90 }}>Qty</th>
                  <th style={{ width: 130 }}>Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i}>
                    <td>
                      <select className="inp" name="model" defaultValue=""
                              style={{ padding: '7px 9px', fontSize: 12.5 }}>
                        <option value="">—</option>
                        {(models ?? []).map((m: any) => (
                          <option key={m.id} value={m.id}>
                            {m.brands?.name ? `${m.brands.name} ` : ''}{m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className="inp" name="stock_item" defaultValue=""
                              style={{ padding: '7px 9px', fontSize: 12.5 }}>
                        <option value="">—</option>
                        {(items ?? []).map((s: any) => (
                          <option key={s.id} value={s.id}>{s.sku} — {s.name}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input className="inp" name="description"
                             placeholder={i === 0 ? 'e.g. Diesel filter' : ''}
                             style={{ padding: '7px 9px', fontSize: 12.5 }} />
                    </td>
                    <td>
                      <input className="inp" name="qty" type="number" step="any" min="0"
                             defaultValue="" style={{ padding: '7px 9px', fontSize: 12.5 }} />
                    </td>
                    <td>
                      <input className="inp" name="unit_cost" placeholder="0"
                             style={{ padding: '7px 9px', fontSize: 12.5 }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ padding: '14px 20px' }}>
            Leave unused rows blank — anything with a quantity of zero is ignored.
          </p>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div style={{ padding: 20 }}>
            <label className="lbl" htmlFor="notes">Notes</label>
            <input className="inp" id="notes" name="notes"
                   placeholder="Anything the supplier or the receiving site should know" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/purchase-orders">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>
            Save as a draft
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          A draft is you thinking. Issuing it is a commitment — that is a separate step, from
          the order itself.
        </p>
      </form>
    </Shell>
  );
}
