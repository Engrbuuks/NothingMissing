import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials } from '@/lib/session';
import { createAsset } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function NewAsset({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const [{ data: locs }, { data: models }, { data: last }] = await Promise.all([
    supabase.from('locations').select('id, name, kind').is('archived_at', null).order('name'),
    supabase.from('models').select('id, name, brands ( name ), sub_categories ( name )').order('name'),
    supabase.from('assets').select('tag').order('tag', { ascending: false }).limit(1),
  ]);

  // Suggest the next tag in whatever sequence is already in use, rather than
  // imposing one. A company with its own numbering keeps it.
  const lastTag = (last ?? [])[0]?.tag ?? '';
  const m = lastTag.match(/^(.*?)(\d+)$/);
  const suggested = m
    ? m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0')
    : 'NM-00001';

  return (
    <Shell current="assets" title="Add an asset" subtitle="One at a time — use Import for a spreadsheet">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={createAsset}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">What it is</div>
              <div className="card-s">
                Linking it to a catalog model means it inherits the specification, service
                interval and warranty term — and it appears in maintenance automatically
              </div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="tag">Asset tag</label>
                <input className="inp mono" id="tag" name="tag" defaultValue={suggested} required />
                <div className="hint">Unique within your company. This is what goes on the label.</div>
              </div>
              <div>
                <label className="lbl" htmlFor="serial">Serial number</label>
                <input className="inp mono" id="serial" name="serial" placeholder="From the nameplate" />
                <div className="hint">Without one it can never be scan-matched in the field.</div>
              </div>
            </div>

            <div>
              <label className="lbl" htmlFor="name">Name</label>
              <input className="inp" id="name" name="name" required placeholder="e.g. Perkins 100 kVA generator" />
            </div>

            <div>
              <label className="lbl" htmlFor="model">Catalog model</label>
              <select className="inp" id="model" name="model">
                <option value="">Not in the catalog</option>
                {(models ?? []).map((m: any) => (
                  <option key={m.id} value={m.id}>
                    {m.brands?.name ? `${m.brands.name} ` : ''}{m.name}
                    {m.sub_categories?.name ? ` · ${m.sub_categories.name}` : ''}
                  </option>
                ))}
              </select>
              {(models ?? []).length === 0 && (
                <div className="hint">
                  Nothing in the catalog yet. You can add this asset without one and link it
                  later — <a href="/catalog" style={{ textDecoration: 'underline' }}>set the catalog up</a>.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div><div className="card-t">Where it is</div><div className="card-s">And who has it</div></div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="location">Location</label>
              <select className="inp" id="location" name="location" required>
                {(locs ?? []).map((l: any) => (
                  <option key={l.id} value={l.id}>{l.name}{l.kind === 'virtual' ? ' (virtual warehouse)' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="holder">Assigned to</label>
              <input className="inp" id="holder" name="holder" placeholder="Person, team or room" />
            </div>
            <div>
              <label className="lbl" htmlFor="acquired">Acquired on</label>
              <input className="inp" id="acquired" name="acquired" type="date" />
            </div>
            <div>
              <label className="lbl" htmlFor="meter">Meter reading</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="inp" id="meter" name="meter" type="number" step="any" placeholder="0" />
                <select className="inp" name="meter_unit" style={{ width: 110 }}>
                  <option value="">—</option>
                  <option value="hours">hours</option>
                  <option value="km">km</option>
                </select>
              </div>
              <div className="hint">Only for metered things — generators, vehicles.</div>
            </div>
          </div>
        </div>

        {canSeeFinancials(session) && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-h bd">
              <div>
                <div className="card-t">What it cost</div>
                <div className="card-s">Stored separately, and only visible to roles that may see it</div>
              </div>
            </div>
            <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="cost">Purchase cost</label>
                <input className="inp" id="cost" name="cost" placeholder="e.g. 1,480,000" />
              </div>
              <div>
                <label className="lbl" htmlFor="invoice">Invoice reference</label>
                <input className="inp" id="invoice" name="invoice" />
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/assets">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>Add to the register</button>
        </div>
      </form>
    </Shell>
  );
}
