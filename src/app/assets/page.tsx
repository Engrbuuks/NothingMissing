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
    view?: string; holder?: string; model?: string;
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

  // Batched is the default. Forty identical machines were forty identical
  // rows, differing only by a tag nobody reads, which buried the one generator
  // underneath them. Every unit stays one click away for when it has to be a
  // particular machine.
  const units = searchParams.view === 'units';
  const fholder = searchParams.holder ?? null;
  const fmodel = searchParams.model ?? null;

  const [{ data: cats }, { data: locs }] = await Promise.all([
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('locations').select('id, name, colour_hex, kind').is('archived_at', null).order('name'),
  ]);

  const catColour = (id?: string) => {
    const i = (cats ?? []).findIndex((c: any) => c.id === id);
    return i >= 0 ? CAT_COLOUR[i % CAT_COLOUR.length] : '#9296AC';
  };

  // ---------------------------------------------------------------- batched
  // Grouped by the database, not here. Collapsing twenty thousand rows in the
  // browser means sending twenty thousand rows to the browser, which is what
  // the old 500 row ceiling was quietly working around.
  let groups: any[] = [];
  let groupError: { message: string } | null = null;
  if (!units) {
    const { data, error } = await supabase.rpc('register_groups', {
      p_q: q || null,
      p_cat: fcat !== 'all' ? fcat : null,
      p_loc: floc !== 'all' ? floc : null,
      p_status: fstatus !== 'all' ? fstatus : null,
    });
    groups = (data ?? []) as any[];
    groupError = error;
  }

  // ------------------------------------------------------------ every unit
  let rows: any[] = [];
  let rowError: { message: string } | null = null;
  let costs = new Map<string, number>();
  if (units) {
    let query = supabase
      .from('assets')
      .select(
        `id, tag, name, serial_no, status, location_id, holder, acquired_on,
         locations ( name, colour_hex ),
         sub_categories ( categories ( id, name ) ),
         models ( name, brands ( name ), sub_categories ( categories ( id, name ) ) )`
      )
      .order('tag')
      .limit(500);

    if (floc !== 'all') query = query.eq('location_id', floc);
    if (fstatus !== 'all') query = query.eq('status', fstatus);
    // Set when arriving from a batch, so the drill down lands on exactly the
    // units that were counted rather than something approximately like them.
    if (fholder !== null) {
      query = fholder === '' ? query.is('holder', null) : query.eq('holder', fholder);
    }
    if (fmodel !== null) {
      query = fmodel === '' ? query.is('model_id', null) : query.eq('model_id', fmodel);
    }
    if (q) {
      query = query.or(
        `tag.ilike.%${q}%,name.ilike.%${q}%,serial_no.ilike.%${q}%,holder.ilike.%${q}%`
      );
    }

    const { data, error } = await query;
    rows = (data ?? []) as any[];
    rowError = error;

    if (fcat !== 'all') {
      rows = rows.filter(
        (a) =>
          (a.models?.sub_categories?.categories?.id ?? a.sub_categories?.categories?.id) === fcat,
      );
    }

    if (showCost && rows.length) {
      const { data: fin } = await supabase
        .from('asset_financials')
        .select('asset_id, purchase_cost_minor')
        .in('asset_id', rows.map((r) => r.id));
      costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f.purchase_cost_minor]));
    }
  }

  const error = groupError ?? rowError;
  const filtered = q !== '' || fcat !== 'all' || floc !== 'all' || fstatus !== 'all';
  const totalUnits = units
    ? rows.length
    : groups.reduce((n, g) => n + Number(g.units), 0);

  const keep = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (fcat !== 'all') p.set('cat', fcat);
    if (floc !== 'all') p.set('loc', floc);
    if (fstatus !== 'all') p.set('status', fstatus);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  };

  const exportQS = new URLSearchParams();
  if (units) exportQS.set('view', 'units');
  if (q) exportQS.set('q', q);
  if (fcat !== 'all') exportQS.set('cat', fcat);
  if (floc !== 'all') exportQS.set('loc', floc);
  if (fstatus !== 'all') exportQS.set('status', fstatus);

  return (
    <Shell
      current="assets"
      title="Asset register"
      subtitle={
        units
          ? `${rows.length} unit${rows.length === 1 ? '' : 's'}${filtered ? ' matching your filters' : ''}`
          : `${totalUnits} asset${totalUnits === 1 ? '' : 's'} in ${groups.length} line${groups.length === 1 ? '' : 's'}`
      }
    >
      {searchParams.imported && (
        <div className="notice">
          <p><b>{searchParams.imported} assets imported.</b> Each is on the register with an audit row against it.</p>
        </div>
      )}
      {searchParams.added && (
        <div className="notice">
          <p>
            <b>{searchParams.added} assets added.</b> They appear as one line with a count.
            Each still has its own history, so they can be moved, repaired and disposed of
            separately.
          </p>
        </div>
      )}
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
        {units && <input type="hidden" name="view" value="units" />}
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search name, serial, tag or holder" />
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
        {filtered && <a className="btn btn-g" href={units ? '/assets?view=units' : '/assets'}>Clear</a>}

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
            <div className="card-t">
              {units ? 'Every unit' : 'Batched'}
            </div>
            <div className="card-s">
              {units
                ? 'One row per machine, with its tag. Use this when it has to be a particular one.'
                : 'Identical things at the same place, in the same state, held by the same person, on one line.'}
              {showCost ? '' : ' Purchase cost is hidden for your role.'}
            </div>
          </div>
          {/* The two views are the same data at two resolutions, so the switch
              carries the filters across rather than resetting them. */}
          <div className="segmented" style={{ marginLeft: 'auto' }}>
            <a className={units ? '' : 'on'} href={`/assets?${keep({})}`}>Batched</a>
            <a className={units ? 'on' : ''} href={`/assets?${keep({ view: 'units' })}`}>Every unit</a>
          </div>
        </div>

        {(units ? rows.length : groups.length) === 0 ? (
          <div className="empty">
            <h4>{filtered ? 'Nothing matches those filters' : 'Nothing on the register yet'}</h4>
            <p>
              {filtered
                ? 'Clear the search or widen the category, location and status filters to see assets again.'
                : 'Either no assets have been added, or none sit at a location your role covers. Both look the same from here, which is the point: the database decides what you can see, not this page.'}
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
        ) : units ? (
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
                {rows.map((a: any) => {
                  const st = ST[a.status] ?? ST.idle;
                  const cat = a.models?.sub_categories?.categories ?? a.sub_categories?.categories;
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
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 86 }}>Units</th>
                  <th>Asset</th><th>Category</th><th>Location</th>
                  <th>Status</th><th>Assigned to</th>
                  {showCost && <th>Purchase cost</th>}
                </tr>
              </thead>
              <tbody>
                {groups.map((g: any) => {
                  const st = ST[g.status] ?? ST.idle;
                  const cc = catColour(g.category_id);
                  const many = Number(g.units) > 1;
                  // Carries the exact grouping columns, so the drill down shows
                  // precisely the units that were counted.
                  const drill = keep({
                    view: 'units',
                    q: g.name,
                    holder: g.holder ?? '',
                    model: g.model_id ?? '',
                    ...(g.location_id ? { loc: g.location_id } : {}),
                    status: g.status,
                  });
                  return (
                    <tr key={g.group_key}>
                      <td>
                        <a className="batch" href={many ? `/assets?${drill}` : `/assets/${g.first_asset}`}>
                          {g.units}
                        </a>
                      </td>
                      <td>
                        <a
                          href={many ? `/assets?${drill}` : `/assets/${g.first_asset}`}
                          style={{ display: 'block' }}
                        >
                          <div className="aname">{g.name}</div>
                          <div className="amake">
                            {[g.brand_name, g.model_name].filter(Boolean).join(' · ') || 'No catalog model'}
                            {Number(g.with_serial) > 0 && ` · ${g.with_serial} with serials`}
                          </div>
                        </a>
                      </td>
                      <td>
                        {g.category_name ? (
                          <span className="pill" style={{ background: cc + '1A', color: cc }}>{g.category_name}</span>
                        ) : (
                          <span className="pill p-mute">Uncategorised</span>
                        )}
                      </td>
                      <td>
                        <span className="loc">
                          <span className="lic" style={{ background: g.status === 'transit' ? '#2E7FF0' : (g.location_hex ?? '#9296AC') }} />
                          {g.status === 'transit' ? 'In transit' : g.location_name ?? '—'}
                        </span>
                      </td>
                      <td><span className={`pill ${st.cls}`}><span className="pd" />{st.label}</span></td>
                      <td style={{ color: 'var(--text-2)' }}>{g.holder ?? '—'}</td>
                      {showCost && (
                        <td className="mono" style={{ fontSize: 12.5 }}>
                          {g.cost_minor == null ? '—' : money(g.cost_minor)}
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
    </Shell>
  );
}
