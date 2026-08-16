import Shell from '@/components/Shell';
import { sb, getSession, canWrite } from '@/lib/session';
import { saveAttribute, deleteAttribute, seedAttributes, applyAttributePack } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const KINDS = [
  ['text', 'Text', 'Anything written — a processor name, a colour'],
  ['number', 'Number', 'A quantity you might want to compare or total'],
  ['dimension', 'Dimension', 'A measurement with a unit — width, height'],
  ['choice', 'Choice', 'One of a fixed list. Use this wherever you can.'],
  ['boolean', 'Yes or no', 'Height adjustable, lockable, serviceable'],
];

export default async function Attributes({
  searchParams,
}: { searchParams: { error?: string; saved?: string; deleted?: string; seeded?: string; pack?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const [{ data: cats }, { data: attrs }, { data: used }] = await Promise.all([
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('attributes')
      .select('id, code, label, kind, unit, choices, required, filterable, category_id, sort_order, help')
      .order('sort_order'),
    supabase.from('model_attributes').select('attribute_id'),
  ]);

  // Packs create the category, a type under it, and the fields together — for
  // a company starting from nothing, which is most of them on day one.
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const { data: packs } = co
    ? await supabase.rpc('available_packs', { p_company: (co as any).id })
    : { data: [] as any[] };

  const categories = (cats ?? []) as any[];
  const list = (attrs ?? []) as any[];
  const usage = new Map<string, number>();
  for (const u of (used ?? []) as any[]) {
    usage.set(u.attribute_id, (usage.get(u.attribute_id) ?? 0) + 1);
  }

  const byCategory = categories.map((c) => ({
    ...c,
    attrs: list.filter((a) => a.category_id === c.id),
  }));
  const universal = list.filter((a) => !a.category_id);

  return (
    <Shell
      current="catalog"
      title="Description fields"
      subtitle="What each kind of thing should be described by"
    >
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved.</p></div>}
      {searchParams.deleted && <div className="notice"><p>Removed.</p></div>}
      {searchParams.pack && (
        <div className="notice">
          <p>
            <b>{searchParams.pack} is set up.</b> The category, a type under it and its
            description fields all exist — adding a model there now gives you a form to fill
            in rather than an empty box.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Starter packs</div>
            <div className="card-s">
              Each creates a category and the handful of fields that actually describe it.
              Short on purpose — six fields get filled in, fifteen get skipped.
            </div>
          </div>
        </div>
        <div className="packgrid">
          {((packs ?? []) as any[]).map((p) => (
            <div className={`pack ${p.applied ? 'done' : ''}`} key={p.pack}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="pack-n">{p.name}</div>
                <div className="pack-d">{p.description}</div>
              </div>
              {p.applied ? (
                <span className="pill p-ok" style={{ flex: 'none' }}><span className="pd" />Set up</span>
              ) : canWrite(session) ? (
                <form action={applyAttributePack.bind(null, p.pack)}>
                  <button className="btn btn-g" type="submit">Add {p.attributes} fields</button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {searchParams.seeded && (
        <div className="notice">
          <p><b>{searchParams.seeded} fields created.</b> Edit or remove any that do not fit.</p>
        </div>
      )}

      <div className="notice">
        <p>
          <b>Fields are defined per category, once.</b> A chair is then never asked for a
          processor, and a computer is never asked for upholstery — so the form for a new
          model is short and obviously relevant, which is the difference between a
          specification that gets filled in and one that does not.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <a className="btn btn-g" href="/catalog">Back to the catalog</a>
        {list.length === 0 && canWrite(session) && (
          <form action={seedAttributes}>
            <button className="btn btn-p" type="submit">Start from a sensible set</button>
          </form>
        )}
      </div>

      {list.length === 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="empty">
            <h4>Nothing defined yet</h4>
            <p>
              Either start from a set we suggest based on your categories — computers get
              processor and memory, furniture gets material and dimensions — or add your own
              below. Anything suggested can be edited or removed.
            </p>
          </div>
        </div>
      )}

      {[...byCategory, { id: null, name: 'Everything', attrs: universal }]
        .filter((g) => g.attrs.length > 0)
        .map((g) => (
          <div className="card" style={{ marginBottom: 18 }} key={g.id ?? 'all'}>
            <div className="card-h bd">
              <div>
                <div className="card-t">{g.name}</div>
                <div className="card-s">
                  {g.id
                    ? `Asked for every model in ${g.name}`
                    : 'Asked for every model, whatever its category'}
                </div>
              </div>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr><th>Field</th><th>Kind</th><th>Options</th><th>Used by</th>
                  {canWrite(session) && <th />}</tr>
                </thead>
                <tbody>
                  {g.attrs.map((a: any) => (
                    <tr key={a.id}>
                      <td>
                        <div className="aname">{a.label}{a.required && <span style={{ color: 'var(--bad)' }}> *</span>}</div>
                        <div className="amake"><span className="tag">{a.code}</span>{a.unit ? ` · ${a.unit}` : ''}</div>
                      </td>
                      <td><span className="pill p-mute">{a.kind}</span></td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-2)', maxWidth: 260 }}>
                        {a.choices?.length ? a.choices.join(', ') : '—'}
                      </td>
                      <td className="mono" style={{ fontSize: 12.5 }}>
                        {usage.get(a.id) ?? 0} model{(usage.get(a.id) ?? 0) === 1 ? '' : 's'}
                      </td>
                      {canWrite(session) && (
                        <td style={{ textAlign: 'right' }}>
                          <form action={deleteAttribute.bind(null, a.id)}>
                            <button className="btn btn-g" type="submit"
                                    style={{ padding: '5px 9px', fontSize: 12, color: 'var(--bad)' }}>
                              Remove
                            </button>
                          </form>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

      {canWrite(session) && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Add a field</div>
              <div className="card-s">
                Reuse the same name to edit an existing one rather than creating a second
              </div>
            </div>
          </div>
          <form action={saveAttribute} style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="category">Applies to</label>
                <select className="inp" id="category" name="category">
                  <option value="">Everything</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="label">Field name</label>
                <input className="inp" id="label" name="label" required placeholder="Upholstery" />
              </div>
              <div>
                <label className="lbl" htmlFor="kind">Kind</label>
                <select className="inp" id="kind" name="kind" defaultValue="text">
                  {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <div className="hint">
                  Prefer a choice wherever the answers are known — that is what makes them
                  comparable later.
                </div>
              </div>
              <div>
                <label className="lbl" htmlFor="unit">Unit</label>
                <input className="inp" id="unit" name="unit" placeholder="mm, kg, GB" />
              </div>
            </div>

            <div>
              <label className="lbl" htmlFor="choices">Options, one per line</label>
              <textarea className="inp" id="choices" name="choices" rows={4}
                        placeholder={'Fabric\nLeather\nMesh'} style={{ resize: 'vertical' }} />
              <div className="hint">Only for a choice field. Two or more, or it is just a text box.</div>
            </div>

            <div>
              <label className="lbl" htmlFor="help">Hint shown under the field</label>
              <input className="inp" id="help" name="help" placeholder="e.g. Measured across the widest point" />
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
                <input type="checkbox" name="required" /> Must be filled in
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
                <input type="checkbox" name="filterable" /> Show on the register
              </label>
              <div style={{ width: 130 }}>
                <label className="lbl" htmlFor="sort">Order</label>
                <input className="inp" id="sort" name="sort" type="number" defaultValue={100} />
              </div>
            </div>

            <div><button className="btn btn-p" type="submit">Add the field</button></div>
          </form>
        </div>
      )}
    </Shell>
  );
}
