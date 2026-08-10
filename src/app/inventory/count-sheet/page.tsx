import Shell from '@/components/Shell';
import { sb } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * A printable count sheet.
 *
 * It shows no quantities. That is the whole point: hand a counter a sheet with
 * the expected figures on it and they will tick along the column, and the count
 * tells you nothing you did not already believe. The comparison happens when
 * the sheet comes back.
 */
export default async function CountSheet({
  searchParams,
}: { searchParams: { loc?: string } }) {
  const supabase = sb();

  const [{ data: items }, { data: locs }] = await Promise.all([
    supabase.from('stock_items').select('sku, name, unit, category').is('archived_at', null).order('sku'),
    supabase.from('locations').select('id, name').is('archived_at', null).order('name'),
  ]);

  const loc = (locs ?? []).find((l: any) => l.id === searchParams.loc);
  const list = (items ?? []) as any[];

  return (
    <Shell current="inventory" title="Count sheet" subtitle={loc ? loc.name : 'All locations'}>
      <div className="notice">
        <p>
          <b>No quantities are printed.</b> Hand someone a sheet showing what the system
          expects and they will tick along the column. The comparison belongs on the review
          screen, after the sheet comes back.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <a className="btn btn-g" href="/inventory">Back to inventory</a>
        <a className="btn btn-p" href="/people">Send a link instead</a>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">Physical count — {loc?.name ?? 'all locations'}</div>
            <div className="card-s">
              Counted by ________________________ on ____ / ____ / ________
            </div>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="empty"><h4>No stock items to count</h4><p>Add some items first.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>SKU</th><th>Item</th><th>Unit</th><th style={{ width: 150 }}>Counted</th><th>Notes</th></tr>
              </thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.sku}>
                    <td><span className="tag">{i.sku}</span></td>
                    <td><div className="aname">{i.name}</div>{i.category && <div className="amake">{i.category}</div>}</td>
                    <td style={{ color: 'var(--text-2)' }}>{i.unit}</td>
                    <td><span style={{ display: 'block', height: 26, borderBottom: '1.5px solid var(--line)' }} /></td>
                    <td><span style={{ display: 'block', height: 26, borderBottom: '1.5px solid var(--line-2)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ padding: '16px 20px' }}>
          Leave a row blank if you could not reach it. Blank means &ldquo;not counted&rdquo;,
          which is not the same as zero — and a zero you did not verify is worse than a gap.
        </p>
      </div>
    </Shell>
  );
}
