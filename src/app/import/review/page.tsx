import Shell from '@/components/Shell';
import { sb, money } from '@/lib/session';
import { commitBranchImport } from '@/lib/actions';
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
}: { searchParams: { branch?: string; existing?: string; city?: string; sheet?: string } }) {
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

      {p.rejected > 0 && (
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

      {errors.length > 0 && (
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
      <p className="hint" style={{ marginTop: 12 }}>
        The whole file imports as one action — if anything fails, nothing is written and you
        can try again. A half-imported register is worse than none.
      </p>
    </Shell>
  );
}
