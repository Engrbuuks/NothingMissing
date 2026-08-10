import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials, canWrite, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ST: Record<string, { label: string; cls: string }> = {
  active: { label: 'In service', cls: 'p-ok' },
  transit: { label: 'In transit', cls: 'p-sky' },
  repair: { label: 'In repair', cls: 'p-warn' },
  idle: { label: 'Unassigned', cls: 'p-mute' },
  retired: { label: 'Retired', cls: 'p-bad' },
};

const CAT_COLOUR = ['#5B4BE8', '#E39A11', '#0FA45E', '#E14B42', '#0EA5B7', '#2E7FF0', '#B91C6B', '#A16207'];

export default async function Assets({
  searchParams,
}: {
  searchParams: {
    q?: string; cat?: string; loc?: string; status?: string;
    imported?: string; disposed?: string; added?: string; error?: string;
  };
}) {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const q = (searchParams.q ?? '').trim();
  const fcat = searchParams.cat ?? 'all';
  const floc = searchParams.loc ?? 'all';
  const fstatus = searchParams.status ?? 'all';

  // Filters are applied in the query, not after fetching: a register of 20,000
  // assets should not travel over the wire to show twelve rows. Row-level
  // security still decides what is visible; these only narrow it further.
  let query = supabase
    .from('assets')
    .select(
      `id, tag, name, serial_no, status, location_id, holder, acquired_on,
       locations ( name, colour_hex ),
       models ( name, brands ( name ), sub_categories ( categories ( id, name ) ) )`
    )
    .order('tag')
    .limit(500);

  if (floc !== 'all') query = query.eq('location_id', floc);
  if (fstatus !== 'all') query = query.eq('status', fstatus);
  if (q) {
    // Tag, serial, name and holder — the four things someone actually has in
    // hand when they are trying to find something.
    query = query.or(
      `tag.ilike.%${q}%,name.ilike.%${q}%,serial_no.ilike.%${q}%,holder.ilike.%${q}%`
    );
  }

  const { data, error } = await query;
  let rows = (data ?? []) as any[];

  // Category sits two joins away and PostgREST cannot filter on a nested
  // relation's parent, so this one narrows after the fetch.
  if (fcat !== 'all') {
    rows = rows.filter((a) => a.models?.sub_categories?.categories?.id === fcat);
  }

  const [{ data: cats }, { data: locs }] = await Promise.all([
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('locations').select('id, name, colour_hex, kind').is('archived_at', null).order('name'),
  ]);

  let costs = new Map<string, number>();
  if (showCost && rows.length) {
    const { data: fin } = await supabase
      .from('asset_financials')
      .select('asset_id, purchase_cost_minor')
      .in('asset_id', rows.map((r) => r.id));
    costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f.purchase_cost_minor]));
  }

  const filtered = q !== '' || fcat !== 'all' || floc !== 'all' || fstatus !== 'all';
  const catColour = (id?: string) => {
    const i = (cats ?? []).findIndex((c: any) => c.id === id);
    return i >= 0 ? CAT_COLOUR[i % CAT_COLOUR.length] : '#9296AC';
  };

  // Export carries the current filters, so what downloads is what is on screen.
  const exportQS = new URLSearchParams();
  if (q) exportQS.set('q', q);
  if (fcat !== 'all') exportQS.set('cat', fcat);
  if (floc !== 'all') exportQS.set('loc', floc);
  if (fstatus !== 'all') exportQS.set('status', fstatus);

  return (
    <Shell
      current="assets"
      title="Asset register"
      subtitle={`${rows.length} asset${rows.length === 1 ? '' : 's'}${filtered ? ' matching your filters' : ''}`}
    >
      {searchParams.imported && (
        <div className="notice">
          <p><b>{searchParams.imported} assets imported.</b> Each is on the register with an audit row against it.</p>
        </div>
      )}
      {searchParams.added && <div className="notice"><p>Added to the register.</p></div>}
      {searchParams.disposed && (
        <div className="notice warn">
          <p>Disposed of. It has left every live register but stays in the history.</p>
        </div>
      )}
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {/* A GET form, so filters live in the URL: a filtered register becomes a
          link someone can send, and the back button behaves. */}
      <form className="toolbar" method="get" action="/assets">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search tag, serial, name or holder" />
        </div>

        <select className="sel" name="cat" defaultValue={fcat}>
          <option value="all">All categories</option>
          {(cats ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select className="sel" name="loc" defaultValue={floc}>
          <option value="all">All locations</option>
          {(locs ?? []).map((l: any) => (
            <option key={l.id} value={l.id}>{l.name}{l.kind === 'virtual' ? ' (virtual)' : ''}</option>
          ))}
        </select>

        <select className="sel" name="status" defaultValue={fstatus}>
          <option value="all">Any status</option>
          {Object.entries(ST).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>

        <button className="btn btn-g" type="submit">Apply</button>
        {filtered && <a className="btn btn-g" href="/assets">Clear</a>}

        <a className="btn btn-g" href={`/assets/export?${exportQS.toString()}`}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          Export
        </a>

        {canWrite(session) && (
          <>
            <a className="btn btn-g" href="/import">Import</a>
            <a className="btn btn-p" href="/assets/new" style={{ marginLeft: 'auto' }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add asset
            </a>
          </>
        )}
      </form>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} asset{rows.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              Click a row to open its history and custody chain
              {showCost ? '' : ' · purchase cost is hidden for your role'}
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="empty">
            <h4>{filtered ? 'Nothing matches those filters' : 'Nothing on the register yet'}</h4>
            <p>
              {filtered
                ? 'Clear the search or widen the category, location and status filters to see assets again.'
                : 'Either no assets have been added, or none sit at a location your role covers. Both look the same from here, which is the point — the database decides what you can see, not this page.'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
              {filtered ? (
                <a className="btn btn-p" href="/assets">Clear filters</a>
              ) : canWrite(session) ? (
                <>
                  <a className="btn btn-p" href="/import">Import a spreadsheet</a>
                  <a className="btn btn-g" href="/assets/new">Add one by hand</a>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tag</th><th>Asset</th><th>Category</th><th>Location</th>
                  <th>Status</th><th>Assigned to</th>
                  {showCost && <th>Purchase cost</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const st = ST[a.status] ?? ST.idle;
                  const cat = a.models?.sub_categories?.categories;
                  const cc = catColour(cat?.id);
                  return (
                    <tr key={a.id}>
                      <td><a className="tag" href={`/assets/${a.id}`}>{a.tag}</a></td>
                      <td>
                        <a href={`/assets/${a.id}`} style={{ display: 'block' }}>
                          <div className="aname">{a.name}</div>
                          <div className="amake">
                            {a.models?.brands?.name ? `${a.models.brands.name} · ` : ''}
                            {a.models?.name ?? (a.serial_no || 'No catalog model')}
                          </div>
                        </a>
                      </td>
                      <td>
                        {cat ? (
                          <span className="pill" style={{ background: cc + '1A', color: cc }}>{cat.name}</span>
                        ) : (
                          <span className="pill p-mute">Uncategorised</span>
                        )}
                      </td>
                      <td>
                        <span className="loc">
                          <span className="lic" style={{ background: a.status === 'transit' ? '#2E7FF0' : (a.locations?.colour_hex ?? '#9296AC') }} />
                          {a.status === 'transit' ? 'In transit' : a.locations?.name ?? '—'}
                        </span>
                      </td>
                      <td><span className={`pill ${st.cls}`}><span className="pd" />{st.label}</span></td>
                      <td style={{ color: 'var(--text-2)' }}>{a.holder ?? '—'}</td>
                      {showCost && <td className="mono" style={{ fontSize: 12.5 }}>{money(costs.get(a.id))}</td>}
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
