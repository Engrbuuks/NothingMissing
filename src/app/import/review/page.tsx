import Shell from '@/components/Shell';
import { sb, money } from '@/lib/session';
import { commitBranchImport, commitStockImport } from '@/lib/actions';
import { parseSheet } from '@/lib/sheet';

export const dynamic = 'force-dynamic';

/**
 * The preview.
 *
 * Importing 400 rows and discovering afterwards that a column was misread is
 * how somebody ends up with 400 assets called "Qty". So the same function runs
 * with commit off, reports exactly what it would create and what it would
 * reject, and writes nothing until the person says yes.
 */
export default async function Review({
  searchParams,
}: {
  searchParams: {
    branch?: string; existing?: string; city?: string; sheet?: string;
    kind?: string; where?: string;
  };
}) {
  if (searchParams.kind === 'stock') {
    return <StockReview raw={searchParams.sheet ?? ''} where={searchParams.where ?? ''} />;
  }
  const raw = searchParams.sheet ?? '';
  const branch = searchParams.branch ?? '';
  const existing = searchParams.existing ?? '';

  const { rows, headers, unknown } = parseSheet(raw);
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();

  const { data: preview, error } = co
    ? await supabase.rpc('import_branch', {
        p_company: (co as any).id,
        p_location_name: branch || 'existing',
        p_rows: rows,
        p_commit: false,
        p_location_id: existing || null,
        p_city: searchParams.city || null,
      })
    : { data: null, error: null as any };

  const p = (preview ?? {}) as any;
  const errors = (p.errors ?? []) as any[];
  const sample = rows.slice(0, 8);

  return (
    <Shell current="import" title="Check before importing" subtitle="Nothing has been written yet">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {rows.length === 0 && (
        <div className="card">
          <div className="empty">
            <h4>No rows could be read</h4>
            <p>
              The first line of what you pasted should be your column names, and there needs
              to be at least one row under it. If you pasted from Excel, select the header
              row as well as the data.
            </p>
            <a className="btn btn-p" href="/import" style={{ marginTop: 18 }}>Go back and paste again</a>
          </div>
        </div>
      )}

      {rows.length > 0 && p.rejected > 0 && (
        <div className="notice warn">
          <p>
            <b>{p.rejected} row{p.rejected === 1 ? '' : 's'} will be skipped.</b> The rest will
            import. Fix these in your spreadsheet and re-paste if you would rather have them
            all, or continue and add them later.
          </p>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="notice">
          <p>
            <b>Ignored column{unknown.length === 1 ? '' : 's'}:</b> {unknown.join(', ')}. Nothing
            is lost from your spreadsheet — these just have nowhere to go on the register.
          </p>
        </div>
      )}

      {rows.length > 0 && (
      <div className="kpis" style={{ marginBottom: 18 }}>
        {[
          { v: String(p.assets ?? 0), l: 'Assets to create', c: '#0FA45E', s: '#E4F7ED' },
          { v: String(p.models ?? 0), l: 'New catalog models', c: '#0551BD', s: '#E7EFFC' },
          { v: String((p.categories ?? 0) + (p.brands ?? 0)), l: 'Categories and brands', c: '#0EA5B7', s: '#E2F6F8' },
          { v: String(p.rejected ?? 0), l: 'Rows skipped', c: p.rejected > 0 ? '#E39A11' : '#9296AC', s: p.rejected > 0 ? '#FDF3E0' : '#F1F2F8' },
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

      )}

      {rows.length > 0 && (
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">
              {p.location_is_new ? 'A new branch will be created' : 'Adding to an existing site'}
              {' — '}{p.location ?? branch}
            </div>
            <div className="card-s">
              Read {rows.length} row{rows.length === 1 ? '' : 's'}, using these columns:{' '}
              {headers.join(', ')}
            </div>
          </div>
        </div>

        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Serial</th><th>Category</th><th>Make and model</th>
                <th>Assigned to</th><th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((r, i) => (
                <tr key={i}>
                  <td><div className="aname">{r.name ?? <span style={{ color: 'var(--bad)' }}>missing</span>}</div></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.serial ?? '—'}</td>
                  <td>{r.category ? <span className="pill p-mute">{r.category}</span> : '—'}</td>
                  <td style={{ color: 'var(--text-2)' }}>
                    {[r.brand, r.model].filter(Boolean).join(' ') || '—'}
                  </td>
                  <td style={{ color: 'var(--text-2)' }}>{r.holder ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {r.cost ? money(Number(r.cost.replace(/[^\d]/g, '')) * 100) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > sample.length && (
          <p className="hint" style={{ padding: '14px 20px' }}>
            Showing the first {sample.length} of {rows.length}. Check these read correctly — if
            a column has landed in the wrong place, go back and adjust your header row.
          </p>
        )}
      </div>

      )}

      {rows.length > 0 && errors.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Rows that will be skipped</div>
              <div className="card-s">Everything else still imports</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Row</th><th>Tag</th><th>Why</th></tr></thead>
              <tbody>
                {errors.slice(0, 25).map((e, i) => (
                  <tr key={i}>
                    <td className="mono">{e.row}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.tag ?? '—'}</td>
                    <td style={{ color: 'var(--text-2)' }}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.length > 0 && (
      <form action={commitBranchImport} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input type="hidden" name="sheet" value={raw} />
        <input type="hidden" name="branch" value={branch} />
        <input type="hidden" name="existing" value={existing} />
        <input type="hidden" name="city" value={searchParams.city ?? ''} />
        <a className="btn btn-g" href="/import">Go back and change it</a>
        <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}
                disabled={(p.assets ?? 0) === 0}>
          {(p.assets ?? 0) > 0
            ? `Import ${p.assets} asset${p.assets === 1 ? '' : 's'}`
            : 'Nothing to import'}
        </button>
      </form>
      )}
      {rows.length > 0 && (
      <p className="hint" style={{ marginTop: 12 }}>
        The whole file imports as one action — if anything fails, nothing is written and you
        can try again. A half-imported register is worse than none.
      </p>
      )}
    </Shell>
  );
}

/** The inventory preview. Same promise as the asset one: nothing is written. */
async function StockReview({ raw, where }: { raw: string; where: string }) {
  const { rows, unknown } = parseSheet(raw, 'stock');
  const supabase = sb();
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();

  const { data: preview, error } = co
    ? await supabase.rpc('import_stock', {
        p_company: (co as any).id,
        p_location_name: where,
        p_rows: rows,
        p_commit: false,
      })
    : { data: null, error: null as any };

  const p = (preview ?? {}) as any;
  const errors = (p.errors ?? []) as any[];
  const warnings = (p.warnings ?? []) as any[];
  const sample = rows.slice(0, 8);

  return (
    <Shell current="import" title="Check before importing" subtitle="Nothing has been written yet">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {rows.length === 0 && (
        <div className="card">
          <div className="empty">
            <h4>No rows could be read</h4>
            <p>
              The first line of what you pasted should be your column names, and there needs
              to be at least one row under it.
            </p>
            <a className="btn btn-p" href="/import?kind=stock" style={{ marginTop: 18 }}>
              Go back and paste again
            </a>
          </div>
        </div>
      )}

      {rows.length > 0 && p.rejected > 0 && (
        <div className="notice warn">
          <p>
            <b>{p.rejected} row{p.rejected === 1 ? '' : 's'} will be skipped.</b> The rest will
            import. The reasons are listed below.
          </p>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="notice">
          <p>
            <b>Ignored column{unknown.length === 1 ? '' : 's'}:</b> {unknown.join(', ')}. Nothing
            is lost from your spreadsheet, these just have nowhere to go.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="notice">
          <p>
            <b>{warnings.length} item{warnings.length === 1 ? '' : 's'} sound like assets.</b>{' '}
            {warnings.slice(0, 4).map((w: any) => w.name).join(', ')}
            {warnings.length > 4 ? ' and others' : ''}. These import as stock anyway. A company
            that genuinely counts its monitors is not wrong, but if you would ever ask where a
            particular one is, it belongs on the asset import instead.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="kpis" style={{ marginBottom: 18 }}>
          <div className="kpi">
            <div className="kpi-v">{p.items ?? 0}</div>
            <div className="kpi-l">Items created</div>
          </div>
          <div className="kpi">
            <div className="kpi-v">{Number(p.units ?? 0).toLocaleString()}</div>
            <div className="kpi-l">Units received</div>
          </div>
          <div className="kpi">
            <div className="kpi-v">{p.location_is_new ? 'New' : 'Existing'}</div>
            <div className="kpi-l">{p.location ?? where}</div>
          </div>
          <div className="kpi">
            <div className="kpi-v">{p.rejected ?? 0}</div>
            <div className="kpi-l">Rows skipped</div>
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div><div className="card-t">Why those rows are skipped</div></div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Row</th><th>Item</th><th>Reason</th></tr></thead>
              <tbody>
                {errors.slice(0, 25).map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{e.row}</td>
                    <td>{e.name ?? e.sku ?? '—'}</td>
                    <td style={{ color: 'var(--text-2)' }}>{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {sample.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">How your columns were read</div>
              <div className="card-s">First {sample.length} row{sample.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Item</th><th>SKU</th><th>Category</th><th>Unit</th><th>Quantity</th><th>Reorder</th><th>Unit cost</th></tr>
              </thead>
              <tbody>
                {sample.map((r, i) => (
                  <tr key={i}>
                    <td><div className="aname">{r.name ?? '—'}</div></td>
                    <td className="mono">{r.sku ?? 'generated'}</td>
                    <td>{r.category ?? '—'}</td>
                    <td>{r.unit ?? 'units'}</td>
                    <td className="mono">{r.qty ?? '0'}</td>
                    <td className="mono">{r.reorder ?? '0'}</td>
                    <td className="mono">{r.cost ? money(Number(String(r.cost).replace(/[^0-9]/g, '')) * 100) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <form action={commitStockImport} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input type="hidden" name="sheet" value={raw} />
          <input type="hidden" name="where" value={where} />
          <a className="btn btn-g" href="/import?kind=stock">Go back and change it</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}
                  disabled={(p.items ?? 0) === 0}>
            {(p.items ?? 0) > 0
              ? `Import ${p.items} item${p.items === 1 ? '' : 's'}`
              : 'Nothing to import'}
          </button>
        </form>
      )}
      {rows.length > 0 && (
        <p className="hint" style={{ marginTop: 12 }}>
          Opening quantities post to the ledger as a receipt, so every figure has a movement
          behind it. The whole file imports as one action.
        </p>
      )}
    </Shell>
  );
}
