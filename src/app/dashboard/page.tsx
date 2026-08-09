import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials } from '@/lib/session';
import { sparkline, donut } from '@/lib/charts';

export const dynamic = 'force-dynamic';

/**
 * The dashboard, built to the prototype rather than reinterpreted from it.
 *
 * Five bands: the hero, what needs you, your assets, movement volume, and what
 * is moving. Every figure is a live count scoped by row-level security —
 * nothing is cached, so nothing can drift from the register.
 */

const short = (minor: number) => {
  const n = minor / 100;
  if (n >= 1e9) return '₦' + (n / 1e9).toFixed(1) + 'b';
  if (n >= 1e6) return '₦' + (n / 1e6).toFixed(1) + 'm';
  if (n >= 1e3) return '₦' + Math.round(n / 1e3) + 'k';
  return '₦' + Math.round(n);
};

const STATUS = [
  { k: 'active',  n: 'In service', c: '#5DCAA5', flat: '#0FA45E' },
  { k: 'transit', n: 'In transit', c: '#85B7EB', flat: '#2E7FF0' },
  { k: 'repair',  n: 'In repair',  c: '#FAC775', flat: '#E39A11' },
  { k: 'idle',    n: 'Unassigned', c: '#B4B2A9', flat: '#9296AC' },
  { k: 'retired', n: 'Retired',    c: '#F09595', flat: '#E14B42' },
];

const CAT_COLOUR = ['#5B4BE8','#E39A11','#0FA45E','#E14B42','#0EA5B7','#2E7FF0','#B91C6B','#A16207'];

export default async function Dashboard() {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);
  const firstName = (session?.fullName ?? session?.email ?? '').split(/[\s@.]/)[0];

  const count = async (t: string, f?: (q: any) => any) => {
    let q = supabase.from(t).select('*', { count: 'exact', head: true });
    if (f) q = f(q);
    const { count: n } = await q;
    return n ?? 0;
  };

  const [pendingReq, pendingSub, inTransit, openDisc, locCount] = await Promise.all([
    count('requests', (q) => q.eq('status', 'pending')),
    count('submissions', (q) => q.eq('status', 'pending')),
    count('transfers', (q) => q.eq('status', 'in_transit')),
    count('discrepancies', (q) => q.is('resolved_at', null)),
    count('locations', (q) => q.is('archived_at', null)),
  ]);

  const { data: assetRows } = await supabase
    .from('assets')
    .select(`id, tag, name, status, acquired_on, location_id,
             locations ( name ),
             models ( name, service_life_years, warranty_months,
                      brands ( name ),
                      sub_categories ( name, categories ( name ) ) )`);
  const assets = (assetRows ?? []) as any[];
  const live = assets.filter((a) => a.status !== 'retired');

  let costs = new Map<string, number>();
  if (showCost && assets.length) {
    const { data: fin } = await supabase
      .from('asset_financials').select('asset_id, purchase_cost_minor');
    costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f.purchase_cost_minor ?? 0]));
  }
  const estateValue = [...costs.values()].reduce((s, v) => s + v, 0);

  // --- first run -------------------------------------------------------------
  if (assets.length === 0) {
    return (
      <Shell current="dashboard" title="Dashboard" subtitle="Nothing on the register yet">
        <div className="card">
          <div className="empty">
            <h4>Welcome{firstName ? `, ${firstName}` : ''}</h4>
            <p>
              Your company exists and you are its owner. Nothing is on the register yet, so
              there is nothing to report. Most registers start as a spreadsheet — importing
              one is usually faster than adding assets by hand.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22, flexWrap: 'wrap' }}>
              <a className="btn btn-p" href="/import">Import a spreadsheet</a>
              <a className="btn btn-g" href="/locations">Add your locations</a>
              <a className="btn btn-g" href="/catalog">Set up the catalog</a>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  // --- shapes ---------------------------------------------------------------
  const health = STATUS.map((s) => ({ ...s, v: assets.filter((a) => a.status === s.k).length }))
                       .filter((s) => s.v > 0);
  const util = assets.length
    ? Math.round(assets.filter((a) => a.status === 'active').length / assets.length * 100) : 0;

  const catMap = new Map<string, any[]>();
  for (const a of live) {
    const n = a.models?.sub_categories?.categories?.name ?? 'Uncategorised';
    catMap.set(n, [...(catMap.get(n) ?? []), a]);
  }
  const cats = [...catMap.entries()]
    .map(([name, rows], i) => ({
      name, rows, colour: CAT_COLOUR[i % CAT_COLOUR.length],
      seg: STATUS.map((s) => rows.filter((r) => r.status === s.k).length),
    }))
    .sort((a, b) => b.rows.length - a.rows.length);
  const catTotal = live.length || 1;

  const top = showCost
    ? assets.map((a) => ({ ...a, cost: costs.get(a.id) ?? 0 }))
            .sort((a, b) => b.cost - a.cost).slice(0, 6)
    : [];
  const topMax = top[0]?.cost || 1;

  const years = new Map<string, number>();
  for (const a of assets) {
    if (!a.acquired_on) continue;
    const y = String(new Date(a.acquired_on).getFullYear());
    years.set(y, (years.get(y) ?? 0) + 1);
  }
  const yKeys = [...years.keys()].sort();
  const yMax = Math.max(1, ...years.values());
  const thisYear = new Date().getFullYear();
  const ageBand = (y: string) => {
    const age = thisYear - Number(y);
    return age <= 1 ? '#0FA45E' : age <= 3 ? '#5B4BE8' : age <= 5 ? '#E39A11' : '#E14B42';
  };

  const brandCount = new Map<string, number>();
  for (const a of live) {
    const b = a.models?.brands?.name;
    if (b) brandCount.set(b, (brandCount.get(b) ?? 0) + 1);
  }
  const brands = [...brandCount.entries()].sort((a, b) => b[1] - a[1]);
  const bMax = brands[0]?.[1] || 1;

  const inWarranty = live.filter((a) => {
    const m = a.models?.warranty_months;
    if (!m || !a.acquired_on) return false;
    return (thisYear - new Date(a.acquired_on).getFullYear()) * 12 < m;
  }).length;
  const pastLife = live.filter((a) => {
    const l = a.models?.service_life_years;
    if (!l || !a.acquired_on) return false;
    return thisYear - new Date(a.acquired_on).getFullYear() >= l;
  }).length;
  const noSerialCount = await count('assets', (q) => q.is('serial_no', null).neq('status', 'retired'));

  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const { data: dueRows } = co
    ? await supabase.rpc('maintenance_due', { p_company: (co as any).id })
    : { data: [] as any[] };
  const dueSvc = ((dueRows ?? []) as any[]).filter((d) => d.state !== 'ok').length;
  const svcTotal = ((dueRows ?? []) as any[]).length;

  const { data: moving } = await supabase
    .from('transfers')
    .select('id, reference, waybill_no, dispatched_at, from:from_location ( name ), to:to_location ( name ), transfer_lines ( count )')
    .eq('status', 'in_transit').order('dispatched_at').limit(4);

  const { data: recent } = await supabase
    .from('audit_events')
    .select('id, occurred_at, actor_label, action, detail, tone')
    .order('occurred_at', { ascending: false }).limit(6);

  // Movement volume over the last eight months, from the audit log rather than
  // a counter — it cannot drift because it is the same rows the log shows.
  const since = new Date(); since.setMonth(since.getMonth() - 8);
  const { data: events } = await supabase
    .from('audit_events').select('occurred_at, entity')
    .gte('occurred_at', since.toISOString()).limit(2000);
  const months: { m: string; t: number; r: number; p: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const rows = (events ?? []).filter((e: any) => e.occurred_at.slice(0, 7) === key);
    months.push({
      m: d.toLocaleString('en-GB', { month: 'short' }),
      t: rows.filter((e: any) => e.entity === 'transfers').length,
      r: rows.filter((e: any) => e.entity === 'assets').length,
      p: rows.filter((e: any) => e.entity === 'purchase_orders' || e.entity === 'requests').length,
    });
  }
  const maxMove = Math.max(1, ...months.map((m) => m.t + m.r + m.p));

  const days = (iso: string | null) =>
    iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

  const actions = [
    { n: pendingReq,  l: 'Awaiting your approval',      m: 'Requests in the chain',        c: '#5B4BE8', s: '#EEEBFE', href: '/requests' },
    { n: inTransit,   l: 'Deliveries to accept',        m: 'Between registers',            c: '#0FA45E', s: '#E4F7ED', href: '/transfers' },
    { n: dueSvc,      l: 'Services past due',           m: 'From the catalog intervals',   c: '#E39A11', s: '#FDF3E0', href: '/maintenance' },
    { n: pendingSub,  l: 'Field submissions to review', m: 'Sent from location links',     c: '#0EA5B7', s: '#E2F6F8', href: '/submissions' },
  ];

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

  return (
    <Shell current="dashboard" title="Dashboard" subtitle={session?.tenant?.name ?? ''}>
      <div className="dash">

        {/* ---------- hero ---------- */}
        <section className="hero">
          <div className="hero-l">
            <div className="hero-eyebrow">
              <span className="tagx">Whole company</span>
              <span className="hero-live"><i />Live</span>
            </div>
            <h1>Good day{firstName ? `, ${firstName}` : ''}</h1>
            <p className="hero-sub">
              {assets.filter((a) => a.status === 'repair').length} out for repair and{' '}
              {assets.filter((a) => a.status === 'transit').length} between registers.
              Everything else is where it should be.
            </p>
            <div className="hero-fig">
              <span className="hero-num">{showCost ? short(estateValue) : 'Restricted'}</span>
            </div>
            <div className="hero-cap">
              {showCost
                ? `Register value across ${locCount} location${locCount === 1 ? '' : 's'}`
                : 'Your role does not include financial visibility'}
            </div>
            {showCost && yKeys.length > 1 && (
              <div
                className="hero-spark"
                dangerouslySetInnerHTML={{
                  __html: sparkline(
                    yKeys.map((y) => {
                      // cumulative purchase cost by year acquired
                      let running = 0;
                      for (const a of assets) {
                        if (!a.acquired_on) continue;
                        if (new Date(a.acquired_on).getFullYear() <= Number(y)) {
                          running += costs.get(a.id) ?? 0;
                        }
                      }
                      return running / 100;
                    }),
                    460, 54, '#8B7BF5', 'hero'
                  ),
                }}
              />
            )}
            <div className="hero-strip">
              <div className="hs"><div className="hs-v">{assets.length}</div><div className="hs-l">Assets tracked</div></div>
              <div className="hs"><div className="hs-v">{brands.length}</div><div className="hs-l">Brands owned</div></div>
              <div className="hs"><div className="hs-v">{locCount}</div><div className="hs-l">Live locations</div></div>
              <div className="hs"><div className="hs-v">{util}%</div><div className="hs-l">In active service</div></div>
            </div>
          </div>
          <div className="hero-r">
            <div className="hero-donut">
              <div className="donut-c"
                dangerouslySetInnerHTML={{
                  __html: donut(health.map((h) => ({ value: h.v, colour: h.c })), 178) +
                    `<div class="donut-mid"><b>${assets.length}</b><span>on register</span></div>`,
                }}
              />
              <div className="dleg">
                {health.map((h) => (
                  <div className="dleg-i" key={h.k}>
                    <i style={{ background: h.c }} />{h.n}<b>{h.v}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- what needs you ---------- */}
        <section className="sect" style={{ marginBottom: -4 }}>
          <div className="sect-h">
            <div><div className="sect-l">Status</div><div className="sect-t">What needs you</div></div>
            <div className="sect-s">
              <div className="ss">
                <div className="ss-v">Today</div>
                <div className="ss-l">{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
              </div>
            </div>
          </div>
        </section>

        <section className="rail">
          {/* The tile with the most waiting gets the ring, so the eye lands on
              the thing that actually needs doing rather than the first card. */}
          {actions.map((a) => (
            <a
              className={`rtile ${a.n > 0 && a.n === Math.max(...actions.map((x) => x.n)) ? 'urgent' : ''}`}
              key={a.l}
              href={a.href}
              style={{ ['--rc' as string]: a.c }}
            >
              <div className="rtile-top">
                <span className="rtile-ic" style={{ background: a.s, color: a.c }}>
                  <span style={{ width: 8, height: 8, borderRadius: 3, background: a.c, display: 'block' }} />
                </span>
                <span className="rtile-go">→</span>
              </div>
              <div className="rtile-n" style={{ color: a.n > 0 ? a.c : 'var(--text-3)' }}>{a.n}</div>
              <div className="rtile-l">{a.l}</div>
              <div className="rtile-m">{a.m}</div>
            </a>
          ))}
        </section>

        {/* ---------- your assets ---------- */}
        <section className="sect">
          <div className="sect-h">
            <div><div className="sect-l">Overview</div><div className="sect-t">Your assets</div></div>
            <div className="sect-s">
              <div className="ss"><div className="ss-v">{assets.length}</div><div className="ss-l">On register</div></div>
              <div className="ss"><div className="ss-v">{cats.length}</div><div className="ss-l">Categories</div></div>
              <div className="ss"><div className="ss-v">{brands.length}</div><div className="ss-l">Brands</div></div>
              <div className="ss">
                <div className="ss-v">{showCost ? short(estateValue) : '—'}</div>
                <div className="ss-l">{showCost ? 'Register value' : 'Value restricted'}</div>
              </div>
            </div>
          </div>

          <div className="ovgrid">
            <div className="card ov-wide">
              <div className="card-h bd">
                <div>
                  <div className="card-t">Status by category</div>
                  <div className="card-s">Where every asset sits right now</div>
                </div>
              </div>
              <div className="mx-h">
                <span>Category</span>
                {STATUS.map((s) => <span key={s.k} title={s.n}>{s.n.split(' ').pop()!.slice(0, 4)}</span>)}
                <span>Spread</span>
              </div>
              {cats.map((c) => (
                <a className="mx" key={c.name} href="/assets">
                  <span className="mx-n">
                    <span className="mx-ic" style={{ background: c.colour + '1A', color: c.colour }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: c.colour, display: 'block' }} />
                    </span>
                    <span className="mx-t">{c.name}</span>
                  </span>
                  {c.seg.map((n, i) => (
                    <span className={`mx-c ${n ? '' : 'z'}`} key={i}>{n || '·'}</span>
                  ))}
                  <span className="mx-b">
                    {c.seg.map((n, i) => n ? <i key={i} style={{ flex: n, background: STATUS[i].flat }} /> : null)}
                  </span>
                </a>
              ))}
              <div className="mx-f">
                <span className="mx-n"><span className="mx-t">All categories</span></span>
                {STATUS.map((s) => {
                  const n = live.filter((a) => a.status === s.k).length;
                  return <span className={`mx-c ${n ? '' : 'z'}`} key={s.k}>{n || '·'}</span>;
                })}
                <span className="mx-b">
                  {STATUS.map((s) => {
                    const n = live.filter((a) => a.status === s.k).length;
                    return n ? <i key={s.k} style={{ flex: n, background: s.flat }} /> : null;
                  })}
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-h bd">
                <div>
                  <div className="card-t">Most valuable</div>
                  <div className="card-s">{showCost ? 'Top six by purchase cost' : 'Restricted to your role'}</div>
                </div>
              </div>
              {showCost ? top.map((a, i) => (
                <a className="tv" key={a.id} href={`/assets/${a.id}`}>
                  <span className="tv-r">{i + 1}</span>
                  <span className="tv-b">
                    <span className="tv-n">{a.name}</span>
                    <span className="tv-bar"><i style={{ width: `${pct(a.cost, topMax)}%`, background: 'var(--brand)' }} /></span>
                    <span className="tv-m">{a.tag} · {a.locations?.name ?? 'in transit'}</span>
                  </span>
                  <span className="tv-v">{short(a.cost)}</span>
                </a>
              )) : (
                <div className="empty" style={{ padding: '36px 20px' }}>
                  <h4>Not available to your role</h4>
                  <p>Ranking assets by cost is financial information. The register itself is fully visible to you.</p>
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-h bd">
                <div><div className="card-t">Age profile</div><div className="card-s">By year acquired</div></div>
              </div>
              <div style={{ padding: '14px 0 6px' }}>
                {yKeys.map((y) => (
                  <div className="age-r" key={y}>
                    <span className="age-y">{y}</span>
                    <span className="age-t"><i style={{ width: `${pct(years.get(y)!, yMax)}%`, background: ageBand(y) }} /></span>
                    <span className="age-n">{years.get(y)}</span>
                  </div>
                ))}
                <div className="age-k">
                  <span><i style={{ background: '#0FA45E' }} />Under 2 yrs</span>
                  <span><i style={{ background: '#5B4BE8' }} />2–3 yrs</span>
                  <span><i style={{ background: '#E39A11' }} />4–5 yrs</span>
                  <span><i style={{ background: '#E14B42' }} />Over 5 yrs</span>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-h bd">
                <div>
                  <div className="card-t">Brands owned</div>
                  <div className="card-s">Resolved through the catalog, not typed-in text</div>
                </div>
                <a className="btn btn-g" href="/catalog" style={{ marginLeft: 'auto' }}>Catalog</a>
              </div>
              <div style={{ padding: '12px 0 14px' }}>
                {brands.slice(0, 7).map(([name, n]) => (
                  <div className="br-r" key={name}>
                    <span className="br-i" style={{ background: 'var(--brand-soft)', color: 'var(--brand-ink)' }}>
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="br-b">
                      <span className="br-n">{name}</span>
                      <span className="br-t"><i style={{ width: `${pct(n, bMax)}%`, background: 'var(--brand)' }} /></span>
                    </span>
                    <span className="br-v">{n}</span>
                  </div>
                ))}
                {brands.length > 7 && (
                  <div style={{ padding: '8px 20px 0' }}>
                    <span className="hint">and {brands.length - 7} further brand{brands.length - 7 === 1 ? '' : 's'} with fewer units</span>
                  </div>
                )}
                {brands.length === 0 && (
                  <p className="hint" style={{ padding: '0 20px' }}>
                    No assets are linked to a catalog model yet, so no brands can be resolved.
                  </p>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-h bd">
                <div>
                  <div className="card-t">Lifecycle health</div>
                  <div className="card-s">Against each model&rsquo;s warranty term and service life</div>
                </div>
              </div>
              <div className="lc">
                {[
                  { v: inWarranty, d: live.length, l: 'Still under warranty', c: '#0FA45E', s: '#E4F7ED' },
                  { v: pastLife, d: live.length, l: 'Past service life, still in use', c: '#E39A11', s: '#FDF3E0' },
                  { v: dueSvc, d: svcTotal || 1, l: 'Due or overdue for service', c: '#E14B42', s: '#FDECEB', href: '/maintenance' },
                  { v: noSerialCount, d: live.length, l: 'No serial, cannot be scanned', c: '#9296AC', s: '#F1F2F8' },
                ].map((x) => (
                  <div className="lc-i" key={x.l}>
                    <div className="lc-top">
                      <span className="lc-ic" style={{ background: x.s, color: x.c }}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: x.c, display: 'block' }} />
                      </span>
                    </div>
                    <div className="lc-v" style={{ color: x.c }}>
                      {x.v}<span style={{ fontSize: 13, color: 'var(--text-3)', fontWeight: 600 }}> / {x.d}</span>
                    </div>
                    <div className="lc-l">{x.l}</div>
                    <div className="lc-bar"><i style={{ width: `${pct(x.v, x.d)}%`, background: x.c }} /></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ---------- movement and transit ---------- */}
        <section className="dgrid">
          <div className="stack">
            <div className="card">
              <div className="card-h">
                <div>
                  <div className="card-t">Movement volume</div>
                  <div className="card-s">Recorded activity each month, straight from the audit log</div>
                </div>
                <a className="btn btn-g" href="/audit" style={{ marginLeft: 'auto' }}>Full log</a>
              </div>
              <div className="leg" style={{ marginTop: 14 }}>
                <span><i style={{ background: '#5B4BE8' }} />Transfers</span>
                <span><i style={{ background: '#E39A11' }} />Assets</span>
                <span><i style={{ background: '#2E7FF0' }} />Requests</span>
              </div>
              <div className="chart-wrap">
                <div className="bars">
                  {months.map((m, i) => {
                    const h = (x: number) => Math.max(2, Math.round((x / maxMove) * 140));
                    return (
                      <div className="bcol" key={m.m + i} title={`${m.m}: ${m.t} transfers, ${m.r} asset changes, ${m.p} requests`}>
                        <div className="bseg" style={{ height: h(m.p), background: '#2E7FF0', animation: `grow .6s cubic-bezier(.2,.85,.3,1) ${(i * 0.05).toFixed(2)}s backwards` }} />
                        <div className="bseg" style={{ height: h(m.r), background: '#E39A11', animation: `grow .6s cubic-bezier(.2,.85,.3,1) ${(i * 0.05 + 0.04).toFixed(2)}s backwards` }} />
                        <div className="bseg" style={{ height: h(m.t), background: '#5B4BE8', animation: `grow .6s cubic-bezier(.2,.85,.3,1) ${(i * 0.05 + 0.08).toFixed(2)}s backwards` }} />
                      </div>
                    );
                  })}
                </div>
                <div className="bx">{months.map((m, i) => <span key={i}>{m.m}</span>)}</div>
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <div>
                  <div className="card-t">What you own</div>
                  <div className="card-s">By category, across every location</div>
                </div>
                <a className="btn btn-g" href="/assets" style={{ marginLeft: 'auto' }}>Open the register</a>
              </div>
              <div className="comp" style={{ marginTop: 16 }}>
                {cats.map((c) => (
                  <i key={c.name} style={{ flex: c.rows.length, background: c.colour }} title={`${c.name}: ${c.rows.length}`} />
                ))}
              </div>
              <div className="complist">
                {cats.map((c) => (
                  <a className="ci" key={c.name} href="/assets">
                    <span className="ci-d" style={{ background: c.colour }} />
                    <span style={{ minWidth: 0 }}>
                      <span className="ci-n">{c.name}</span>
                      <span className="ci-m">{pct(c.rows.length, catTotal)}% of register</span>
                    </span>
                    <span className="ci-v">{c.rows.length}</span>
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="card">
              <div className="card-h">
                <div>
                  <div className="card-t">In transit</div>
                  <div className="card-s">Held by neither register until accepted</div>
                </div>
                <a className="btn btn-g" href="/transfers" style={{ marginLeft: 'auto' }}>All</a>
              </div>
              {(moving ?? []).length === 0 ? (
                <div className="empty" style={{ padding: '40px 20px' }}>
                  <h4>Nothing in transit</h4>
                  <p>Every asset is on a register. That is the state you want the system in.</p>
                </div>
              ) : (
                <div className="tt">
                  {(moving ?? []).map((t: any) => {
                    const d = days(t.dispatched_at) ?? 0;
                    const over = d > 3;
                    const prog = Math.min(0.95, 0.25 + d * 0.18);
                    return (
                      <a className="trip" key={t.id} href={`/transfers/${t.id}`}>
                        <div className="trip-h">
                          <span className="trip-w">{t.waybill_no ?? t.reference}</span>
                          <span className={`pill ${over ? 'p-bad' : 'p-sky'}`} style={{ marginLeft: 'auto' }}>
                            <span className="pd" />{over ? 'Overdue' : 'In transit'}
                          </span>
                        </div>
                        <div className="track">
                          <div className="track-line">
                            <div className="track-fill" style={{ width: `${prog * 100}%` }} />
                            <span className="track-node done" style={{ left: 0 }} />
                            <span className="track-node" style={{ left: '100%' }} />
                            <span className="track-van" style={{ left: `${prog * 100}%` }}>
                              <span style={{ width: 7, height: 7, borderRadius: 2, background: '#fff', display: 'block' }} />
                            </span>
                          </div>
                          <div className="track-ends">
                            <div><div className="te-l">From</div><div className="te-v">{t.from?.name ?? '—'}</div></div>
                            <div className="te-r"><div className="te-l">To</div><div className="te-v">{t.to?.name ?? '—'}</div></div>
                          </div>
                        </div>
                        <div className="trip-f">
                          <span><b>{t.transfer_lines?.[0]?.count ?? 0}</b> assets</span>
                          <span className="age" style={{ color: over ? 'var(--bad)' : 'var(--text-2)' }}>
                            {over ? `${d} days overdue` : `Day ${d}`}
                          </span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="card">
              <div className="card-h bd">
                <div>
                  <div className="card-t">Activity</div>
                  <div className="card-s">Every movement writes to the audit log</div>
                </div>
                <a className="btn btn-g" href="/audit" style={{ marginLeft: 'auto' }}>Log</a>
              </div>
              <div className="feed">
                {(recent ?? []).length === 0 ? (
                  <p className="hint" style={{ padding: '18px 20px' }}>Nothing recorded yet.</p>
                ) : (recent ?? []).map((e: any) => (
                  <div className="fi" key={e.id}>
                    <span className={`pill ${e.tone === 'ok' ? 'p-ok' : e.tone === 'warn' ? 'p-warn' : e.tone === 'bad' ? 'p-bad' : 'p-mute'}`}
                          style={{ flex: 'none', alignSelf: 'flex-start' }}>
                      <span className="pd" />{e.action}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="fi-t">{e.detail ?? '—'}</div>
                      <div className="fi-m">{e.actor_label} · {new Date(e.occurred_at).toLocaleString('en-GB')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </Shell>
  );
}
