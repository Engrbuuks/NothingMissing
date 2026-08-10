import Shell from '@/components/Shell';
import { sb, getSession, canWrite, canSeeFinancials, money } from '@/lib/session';
import { createCategory, createSubCategory, createBrand, createModel } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const CAT_COLOUR = ['#5B4BE8', '#E39A11', '#0FA45E', '#E14B42', '#0EA5B7', '#2E7FF0', '#B91C6B', '#A16207'];

/**
 * The catalog: category → type → brand → model → units.
 *
 * The point of it is that a model holds the specification once and every unit
 * inherits it. That is what makes "how reliable is the Cummins C250" a question
 * with an answer, rather than a pattern you have to spot across rows that
 * happen to be spelled alike.
 */
export default async function Catalog({
  searchParams,
}: { searchParams: { q?: string; cat?: string; error?: string; added?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const q = (searchParams.q ?? '').trim();
  const fcat = searchParams.cat ?? 'all';

  const [{ data: cats }, { data: subs }, { data: brands }, { data: models }, { data: assets }] =
    await Promise.all([
      supabase.from('categories').select('id, name').order('name'),
      supabase.from('sub_categories').select('id, name, category_id').order('name'),
      supabase.from('brands').select('id, name').order('name'),
      supabase
        .from('models')
        .select(`id, name, introduced_year, service_life_years, warranty_months,
                 service_interval, service_interval_unit, consumption_rate, list_cost_minor,
                 specs, spares, brand_id, sub_category_id,
                 brands ( name ), sub_categories ( name, category_id )`)
        .order('name'),
      supabase.from('assets').select('id, model_id, status'),
    ]);

  const categories = (cats ?? []) as any[];
  const subCats = (subs ?? []) as any[];
  const brandList = (brands ?? []) as any[];
  let modelList = (models ?? []) as any[];
  const assetList = (assets ?? []) as any[];

  if (fcat !== 'all') modelList = modelList.filter((m) => m.sub_categories?.category_id === fcat);
  if (q) {
    const needle = q.toLowerCase();
    modelList = modelList.filter((m) =>
      (m.name + ' ' + (m.brands?.name ?? '') + ' ' + (m.sub_categories?.name ?? ''))
        .toLowerCase().includes(needle)
    );
  }

  const unitsOf = (modelId: string) => assetList.filter((a) => a.model_id === modelId);
  const colour = (catId?: string) => {
    const i = categories.findIndex((c) => c.id === catId);
    return i >= 0 ? CAT_COLOUR[i % CAT_COLOUR.length] : '#9296AC';
  };
  const filtered = q !== '' || fcat !== 'all';
  const unlinked = assetList.filter((a) => !a.model_id).length;

  return (
    <Shell
      current="catalog"
      title="Catalog"
      subtitle={`${categories.length} categories · ${brandList.length} brands · ${modelList.length} models`}
    >
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.added && <div className="notice"><p>Added to the catalog.</p></div>}

      <form className="toolbar" method="get" action="/catalog">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search model, brand or type" />
        </div>
        <select className="sel" name="cat" defaultValue={fcat}>
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn btn-g" type="submit">Apply</button>
        {filtered && <a className="btn btn-g" href="/catalog">Clear</a>}
      </form>

      {unlinked > 0 && (
        <div className="notice warn">
          <p>
            <b>{unlinked} asset{unlinked === 1 ? '' : 's'} not linked to a model.</b> They work
            fine, but they inherit no specification, no service interval and no warranty term —
            so they never appear in maintenance and their brand cannot be counted.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{modelList.length} model{modelList.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              A model holds the specification once. Every unit of it inherits it, so buying six
              more needs no configuration.
            </div>
          </div>
        </div>
        {modelList.length === 0 ? (
          <div className="empty">
            <h4>{filtered ? 'Nothing matches' : 'No models yet'}</h4>
            <p>
              {filtered
                ? 'Clear the search or widen the category filter.'
                : 'Start with a category, then a type, then a brand — a model needs all three.'}
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th><th>Type</th><th>Units owned</th><th>Service life</th>
                  <th>Warranty</th><th>Service every</th>
                  {canSeeFinancials(session) && <th>List cost</th>}
                </tr>
              </thead>
              <tbody>
                {modelList.map((m) => {
                  const units = unitsOf(m.id);
                  const live = units.filter((u) => u.status !== 'retired').length;
                  const c = colour(m.sub_categories?.category_id);
                  return (
                    <tr key={m.id}>
                      <td>
                        <div className="aname">{m.brands?.name ? `${m.brands.name} ` : ''}{m.name}</div>
                        <div className="amake">
                          {Array.isArray(m.specs) && m.specs.length
                            ? m.specs.slice(0, 2).map((s: any) => `${s[0]}: ${s[1]}`).join(' · ')
                            : 'No specification recorded'}
                        </div>
                      </td>
                      <td>
                        <span className="pill" style={{ background: c + '1A', color: c }}>
                          {m.sub_categories?.name ?? '—'}
                        </span>
                      </td>
                      <td>
                        <b className="mono" style={{ fontSize: 14 }}>{live}</b>
                        {units.length > live && (
                          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}> +{units.length - live} retired</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{m.service_life_years ? `${m.service_life_years} yrs` : '—'}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{m.warranty_months ? `${m.warranty_months} mo` : '—'}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>
                        {m.service_interval ? `${Number(m.service_interval).toLocaleString()} ${m.service_interval_unit ?? ''}` : '—'}
                        {m.consumption_rate && (
                          <div className="amake">{m.consumption_rate} L/hr</div>
                        )}
                      </td>
                      {canSeeFinancials(session) && (
                        <td className="mono" style={{ fontSize: 12.5 }}>{money(m.list_cost_minor)}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="ovgrid">
        <div className="card">
          <div className="card-h bd">
            <div><div className="card-t">Categories</div><div className="card-s">The top of the hierarchy</div></div>
          </div>
          <div style={{ padding: '10px 0' }}>
            {categories.map((c, i) => {
              const n = subCats.filter((s) => s.category_id === c.id).length;
              return (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 20px' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: CAT_COLOUR[i % CAT_COLOUR.length] }} />
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{c.name}</span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{n} type{n === 1 ? '' : 's'}</span>
                </div>
              );
            })}
            {categories.length === 0 && <p className="hint" style={{ padding: '0 20px' }}>None yet.</p>}
          </div>
          {canWrite(session) && (
            <form action={createCategory} style={{ padding: '4px 20px 20px', display: 'flex', gap: 8 }}>
              <input className="inp" name="name" placeholder="New category" required />
              <button className="btn btn-g" type="submit">Add</button>
            </form>
          )}
        </div>

        <div className="card">
          <div className="card-h bd">
            <div><div className="card-t">Types</div><div className="card-s">Within a category</div></div>
          </div>
          <div style={{ padding: '10px 0' }}>
            {subCats.map((s) => {
              const cat = categories.find((c) => c.id === s.category_id);
              return (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 20px' }}>
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
                  <span className="pill p-mute">{cat?.name ?? '—'}</span>
                </div>
              );
            })}
            {subCats.length === 0 && <p className="hint" style={{ padding: '0 20px' }}>None yet.</p>}
          </div>
          {canWrite(session) && categories.length > 0 && (
            <form action={createSubCategory} style={{ padding: '4px 20px 20px', display: 'grid', gap: 8 }}>
              <select className="inp" name="category" required>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" name="name" placeholder="New type" required />
                <button className="btn btn-g" type="submit">Add</button>
              </div>
            </form>
          )}
        </div>

        <div className="card">
          <div className="card-h bd">
            <div><div className="card-t">Brands</div><div className="card-s">Resolved through the catalog, never typed on an asset</div></div>
          </div>
          <div style={{ padding: '10px 0' }}>
            {brandList.map((b) => {
              const n = modelList.filter((m) => m.brand_id === b.id).length;
              return (
                <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 20px' }}>
                  <span className="br-i" style={{ background: 'var(--brand-soft)', color: 'var(--brand-ink)' }}>
                    {b.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{b.name}</span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>{n} model{n === 1 ? '' : 's'}</span>
                </div>
              );
            })}
            {brandList.length === 0 && <p className="hint" style={{ padding: '0 20px' }}>None yet.</p>}
          </div>
          {canWrite(session) && (
            <form action={createBrand} style={{ padding: '4px 20px 20px', display: 'flex', gap: 8 }}>
              <input className="inp" name="name" placeholder="New brand" required />
              <button className="btn btn-g" type="submit">Add</button>
            </form>
          )}
        </div>

        {canWrite(session) && subCats.length > 0 && brandList.length > 0 && (
          <div className="card ov-wide">
            <div className="card-h bd">
              <div>
                <div className="card-t">Add a model</div>
                <div className="card-s">
                  The lifecycle figures here are inherited by every unit — set them once and
                  maintenance schedules itself
                </div>
              </div>
            </div>
            <form action={createModel} style={{ padding: 20, display: 'grid', gap: 14 }}>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
                <div>
                  <label className="lbl" htmlFor="brand">Brand</label>
                  <select className="inp" id="brand" name="brand" required>
                    {brandList.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="lbl" htmlFor="sub_category">Type</label>
                  <select className="inp" id="sub_category" name="sub_category" required>
                    {subCats.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="lbl" htmlFor="mname">Model name</label>
                  <input className="inp" id="mname" name="name" required placeholder="e.g. 1104A-44TG2 100 kVA" />
                </div>
              </div>

              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
                <div>
                  <label className="lbl" htmlFor="life">Service life (years)</label>
                  <input className="inp" id="life" name="life" type="number" min="1" max="100" />
                </div>
                <div>
                  <label className="lbl" htmlFor="warranty">Warranty (months)</label>
                  <input className="inp" id="warranty" name="warranty" type="number" min="0" />
                </div>
                <div>
                  <label className="lbl" htmlFor="interval">Service every</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="inp" id="interval" name="interval" type="number" min="1" />
                    <select className="inp" name="interval_unit" style={{ width: 110 }}>
                      <option value="hours">hours</option>
                      <option value="km">km</option>
                      <option value="months">months</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="lbl" htmlFor="rate">Fuel use (L/hr)</label>
                  <input className="inp" id="rate" name="rate" type="number" step="0.1" min="0" />
                  <div className="hint">Only for metered engines. This is what the fuel check compares against.</div>
                </div>
              </div>

              <div><button className="btn btn-p" type="submit">Add the model</button></div>
            </form>
          </div>
        )}
      </div>
    </Shell>
  );
}
