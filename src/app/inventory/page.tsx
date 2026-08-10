import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials, canWrite, money } from '@/lib/session';
import { issueStock, receiveStock, transferStock, deleteStockItem, archiveStockItem } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const short = (minor: number) => {
  const n = minor / 100;
  if (n >= 1e9) return '₦' + (n / 1e9).toFixed(1) + 'b';
  if (n >= 1e6) return '₦' + (n / 1e6).toFixed(1) + 'm';
  if (n >= 1e3) return '₦' + Math.round(n / 1e3) + 'k';
  return '₦' + Math.round(n);
};

export default async function Inventory({
  searchParams,
}: { searchParams: { q?: string; cat?: string; loc?: string; error?: string; added?: string; moved?: string; deleted?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const q = (searchParams.q ?? '').trim();
  const fcat = searchParams.cat ?? 'all';
  const floc = searchParams.loc ?? 'all';

  let itemQ = supabase
    .from('stock_items')
    .select('id, sku, name, category, unit, is_divisible, reorder_point, unit_cost_minor, variance_tolerance_pct')
    .is('archived_at', null)
    .order('sku');
  if (fcat !== 'all') itemQ = itemQ.eq('category', fcat);
  if (q) itemQ = itemQ.or(`sku.ilike.%${q}%,name.ilike.%${q}%`);

  const [{ data: items, error }, { data: balances }, { data: locs }, { data: allItems }] = await Promise.all([
    itemQ,
    supabase.from('stock_balances').select('item_id, location_id, qty'),
    supabase.from('locations').select('id, name, kind').is('archived_at', null).order('name'),
    supabase.from('stock_items').select('category').is('archived_at', null),
  ]);

  const list = (items ?? []) as any[];
  const bals = (balances ?? []) as any[];

  // Balance for an item, either everywhere or at one site.
  const at = (itemId: string) =>
    bals
      .filter((b) => b.item_id === itemId && (floc === 'all' || b.location_id === floc))
      .reduce((s, b) => s + Number(b.qty), 0);

  const stateOf = (i: any) => {
    const qty = at(i.id);
    if (qty <= 0) return 'out';
    if (qty < Number(i.reorder_point)) return 'low';
    return 'ok';
  };

  const categories = [...new Set((allItems ?? []).map((i: any) => i.category).filter(Boolean))].sort();
  const low = list.filter((i) => stateOf(i) !== 'ok').length;
  const out = list.filter((i) => stateOf(i) === 'out').length;
  const value = list.reduce((s, i) => s + at(i.id) * Number(i.unit_cost_minor ?? 0), 0);
  const where = floc === 'all'
    ? 'across all locations'
    : 'at ' + ((locs ?? []).find((l: any) => l.id === floc)?.name ?? 'this site');

  const filtered = q !== '' || fcat !== 'all';

  // Recent ledger movements, which are the answer to "why is there 3,910?"
  const { data: recent } = await supabase
    .from('stock_movements')
    .select('id, kind, qty, balance_after, occurred_at, reason, actor_label, stock_items ( sku, name, unit ), locations ( name )')
    .order('id', { ascending: false })
    .limit(12);

  const KIND: Record<string, { label: string; cls: string }> = {
    receipt: { label: 'Received', cls: 'p-ok' },
    issue: { label: 'Issued', cls: 'p-sky' },
    return: { label: 'Returned', cls: 'p-ok' },
    transfer_out: { label: 'Sent out', cls: 'p-mute' },
    transfer_in: { label: 'Came in', cls: 'p-mute' },
    count_adjust: { label: 'Count adjustment', cls: 'p-warn' },
    loss: { label: 'Loss', cls: 'p-bad' },
  };

  return (
    <Shell current="inventory" title="Inventory" subtitle={`Consumable stock ${where}`}>
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.added && <div className="notice"><p>Stock item added.</p></div>}
      {searchParams.deleted && <div className="notice"><p>Done.</p></div>}
      {searchParams.moved && <div className="notice"><p>Recorded. The ledger has a row with your name on it.</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <form className="toolbar" method="get" action="/inventory">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search SKU or item name" />
        </div>
        <select className="sel" name="cat" defaultValue={fcat}>
          <option value="all">All categories</option>
          {categories.map((c: any) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="sel" name="loc" defaultValue={floc}>
          <option value="all">All locations</option>
          {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn btn-g" type="submit">Apply</button>
        {filtered && <a className="btn btn-g" href="/inventory">Clear</a>}
        <a className="btn btn-g" href={`/inventory/count-sheet${floc !== 'all' ? `?loc=${floc}` : ''}`}>Count sheet</a>
        {canWrite(session) && (
          <a className="btn btn-p" href="/inventory/new" style={{ marginLeft: 'auto' }}>Add item</a>
        )}
      </form>

      <div className="kpis" style={{ marginBottom: 18 }}>
        {[
          { v: String(list.length), l: 'Stock items tracked', c: '#5B4BE8', s: '#EEEBFE' },
          { v: String(low), l: 'At or below reorder', c: '#E39A11', s: '#FDF3E0' },
          { v: String(out), l: 'Out of stock', c: '#E14B42', s: '#FDECEB' },
          { v: showCost ? short(value) : 'Hidden', l: showCost ? `Stock value ${where}` : 'Value restricted', c: '#0FA45E', s: '#E4F7ED' },
        ].map((k) => (
          <div className="kpi" key={k.l}>
            <div className="kpi-top">
              <span className="kpi-ic" style={{ background: k.s, color: k.c }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: k.c, display: 'block' }} />
              </span>
            </div>
            <div className="kpi-v" style={{ color: k.c }}>{k.v}</div>
            <div className="kpi-l">{k.l}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{list.length} item{list.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              Every figure is the sum of the ledger, never a number someone typed
            </div>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="empty">
            <h4>{filtered ? 'Nothing matches those filters' : 'No stock items yet'}</h4>
            <p>
              {filtered
                ? 'Clear the search or widen the category filter.'
                : 'Add the consumables you actually track — diesel, filters, safety gear. Anything a storekeeper counts.'}
            </p>
            {!filtered && canWrite(session) && (
              <a className="btn btn-p" href="/inventory/new" style={{ marginTop: 18 }}>Add the first item</a>
            )}
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th><th>Item</th><th>Category</th><th>On hand</th>
                  <th>Reorder at</th><th>Status</th>{showCost && <th>Value</th>}
                  {canWrite(session) && <th />}
                </tr>
              </thead>
              <tbody>
                {list.map((i) => {
                  const qty = at(i.id);
                  const st = stateOf(i);
                  const col = st === 'out' ? '#E14B42' : st === 'low' ? '#E39A11' : '#0FA45E';
                  const pct = Math.min(100, Math.round((qty / (Number(i.reorder_point) * 2.5 || 1)) * 100));
                  return (
                    <tr key={i.id}>
                      <td><span className="tag">{i.sku}</span></td>
                      <td><div className="aname">{i.name}</div><div className="amake">{i.unit}</div></td>
                      <td>{i.category ? <span className="pill p-mute">{i.category}</span> : '—'}</td>
                      <td style={{ minWidth: 150 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                          <b className="mono" style={{ fontSize: 14, color: col }}>{qty.toLocaleString()}</b>
                          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{i.unit}</span>
                        </div>
                        <div className="stockbar"><i style={{ width: `${pct}%`, background: col }} /></div>
                      </td>
                      <td className="mono" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
                        {Number(i.reorder_point).toLocaleString()}
                      </td>
                      <td>
                        <span className={`pill ${st === 'out' ? 'p-bad' : st === 'low' ? 'p-warn' : 'p-ok'}`}>
                          <span className="pd" />
                          {st === 'out' ? 'Out of stock' : st === 'low' ? 'Below reorder' : 'In stock'}
                        </span>
                      </td>
                      {showCost && (
                        <td className="mono" style={{ fontSize: 12.5 }}>{money(qty * Number(i.unit_cost_minor ?? 0))}</td>
                      )}
                      {canWrite(session) && (
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <form action={archiveStockItem.bind(null, i.id)}>
                              <button className="btn btn-g" type="submit" style={{ padding: '5px 9px', fontSize: 12 }}>Archive</button>
                            </form>
                            <form action={deleteStockItem.bind(null, i.id)}>
                              <button className="btn btn-g" type="submit" style={{ padding: '5px 9px', fontSize: 12, color: 'var(--bad)' }}>Delete</button>
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
      </div>

      {canWrite(session) && list.length > 0 && (
        <div className="ovgrid" style={{ marginBottom: 18 }}>
          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Issue stock</div>
                <div className="card-s">Drawn for a job or an asset. Capturing the meter is what makes the fuel check possible.</div>
              </div>
            </div>
            <form action={issueStock} style={{ padding: 20, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>
                {list.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>)}
              </select>
              <select className="inp" name="location" required>
                {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 10 }}>
                <input className="inp" name="qty" type="number" step="any" min="0" placeholder="Quantity" required />
                <input className="inp" name="meter" type="number" step="any" placeholder="Meter reading" />
              </div>
              <input className="inp" name="reason" placeholder="What it was for" />
              <button className="btn btn-p" type="submit">Record the issue</button>
            </form>
          </div>

          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Receive stock</div>
                <div className="card-s">A delivery arriving. Raises the balance and leaves a row saying who accepted it.</div>
              </div>
            </div>
            <form action={receiveStock} style={{ padding: 20, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>
                {list.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>)}
              </select>
              <select className="inp" name="location" required>
                {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <input className="inp" name="qty" type="number" step="any" min="0" placeholder="Quantity received" required />
              <input className="inp" name="reason" placeholder="Supplier or delivery note" />
              <button className="btn btn-p" type="submit">Record the receipt</button>
            </form>
          </div>

          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Move between sites</div>
                <div className="card-s">Both legs post together, or neither. A half-completed transfer invents a shortage.</div>
              </div>
            </div>
            <form action={transferStock} style={{ padding: 20, display: 'grid', gap: 12 }}>
              <select className="inp" name="item" required>
                {list.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 10 }}>
                <select className="inp" name="from" required>
                  {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>From {l.name}</option>)}
                </select>
                <select className="inp" name="to" required>
                  {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>To {l.name}</option>)}
                </select>
              </div>
              <input className="inp" name="qty" type="number" step="any" min="0" placeholder="Quantity" required />
              <input className="inp" name="reason" placeholder="Why" />
              <button className="btn btn-p" type="submit">Move it</button>
            </form>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">The ledger</div>
            <div className="card-s">
              Append-only. A correction is a further movement, never an edit — which is why
              every balance can be explained.
            </div>
          </div>
        </div>
        {(recent ?? []).length === 0 ? (
          <div className="empty"><h4>Nothing recorded yet</h4><p>Receipts, issues and count adjustments appear here.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Item</th><th>Movement</th><th>Change</th><th>Balance after</th><th>Where</th><th>Who</th></tr></thead>
              <tbody>
                {(recent ?? []).map((m: any) => {
                  const k = KIND[m.kind] ?? KIND.receipt;
                  const neg = Number(m.qty) < 0;
                  return (
                    <tr key={m.id}>
                      <td style={{ color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                        {new Date(m.occurred_at).toLocaleDateString('en-GB')}
                      </td>
                      <td>
                        <div className="aname">{m.stock_items?.name}</div>
                        <div className="amake"><span className="tag">{m.stock_items?.sku}</span></div>
                      </td>
                      <td>
                        <span className={`pill ${k.cls}`}><span className="pd" />{k.label}</span>
                        {m.reason && <div className="amake" style={{ marginTop: 4 }}>{m.reason}</div>}
                      </td>
                      <td className="mono" style={{ color: neg ? 'var(--bad)' : 'var(--ok)', fontWeight: 600 }}>
                        {neg ? '' : '+'}{Number(m.qty).toLocaleString()}
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{Number(m.balance_after).toLocaleString()}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.locations?.name ?? '—'}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.actor_label}</td>
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
