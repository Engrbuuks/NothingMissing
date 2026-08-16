import Shell from '@/components/Shell';
import { sb, getSession, hasRole, canWrite, canSeeFinancials } from '@/lib/session';
import { updateAsset } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Editing an asset.
 *
 * The fields are split by who may change them, and the page says why rather
 * than just disabling things. A greyed-out box with no explanation reads as a
 * bug; a greyed-out box with a reason reads as a rule.
 */
export default async function EditAsset({
  params, searchParams,
}: { params: { id: string }; searchParams: { error?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: asset } = await supabase
    .from('assets')
    .select('id, tag, name, serial_no, status, location_id, holder, acquired_on, meter_value, meter_unit, model_id, notes')
    .eq('id', params.id)
    .maybeSingle();

  if (!asset) {
    return (
      <Shell current="assets" title="Not found" subtitle="">
        <div className="card"><div className="empty"><h4>That asset is not here</h4>
        <p>It may have been disposed of, or it sits at a location your role does not cover.</p></div></div>
      </Shell>
    );
  }

  const a = asset as any;
  const senior = hasRole(session, 'owner', 'admin');
  const canRetire = hasRole(session, 'owner', 'admin', 'manager');

  if (!canWrite(session)) {
    return (
      <Shell current="assets" title={a.name} subtitle="Read only">
        <div className="card"><div className="empty"><h4>Your role cannot edit assets</h4>
        <p>An auditor reads everything and changes nothing — deliberately.</p></div></div>
      </Shell>
    );
  }

  const [{ data: locs }, { data: models }] = await Promise.all([
    supabase.from('locations').select('id, name, kind').is('archived_at', null).order('name'),
    supabase.from('models').select('id, name, brands ( name )').order('name'),
  ]);

  return (
    <Shell current="assets" title={`Edit ${a.tag}`} subtitle={a.name}>
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={updateAsset}>
        <input type="hidden" name="id" value={a.id} />

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Identity</div>
              <div className="card-s">
                {senior
                  ? 'Changing these breaks the link to labels and waybills already issued — do it only to correct a mistake.'
                  : 'Only an owner or admin can change these. The serial is what ties this row to a physical machine, and the tag is printed on the label.'}
              </div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="tag">Asset tag</label>
              <input className="inp mono" id="tag" name="tag" defaultValue={a.tag} disabled={!senior} />
            </div>
            <div>
              <label className="lbl" htmlFor="serial">Serial number</label>
              <input className="inp mono" id="serial" name="serial" defaultValue={a.serial_no ?? ''}
                     disabled={!senior && Boolean(a.serial_no)} />
              {!a.serial_no && (
                <div className="hint">
                  Blank — anyone who can edit may fill it in. Once recorded, only an admin can
                  change it.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div><div className="card-t">Details</div><div className="card-s">Anyone who can edit may change these</div></div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div>
              <label className="lbl" htmlFor="name">Name</label>
              <input className="inp" id="name" name="name" defaultValue={a.name} required />
            </div>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="holder">Assigned to</label>
                <input className="inp" id="holder" name="holder" defaultValue={a.holder ?? ''} />
              </div>
              <div>
                <label className="lbl" htmlFor="model">Catalog model</label>
                <select className="inp" id="model" name="model" defaultValue={a.model_id ?? ''}>
                  <option value="">Not in the catalog</option>
                  {(models ?? []).map((m: any) => (
                    <option key={m.id} value={m.id}>
                      {m.brands?.name ? `${m.brands.name} ` : ''}{m.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="meter">Meter reading</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="inp" id="meter" name="meter" type="number" step="any"
                         defaultValue={a.meter_value ?? ''} />
                  <select className="inp" name="meter_unit" defaultValue={a.meter_unit ?? ''} style={{ width: 100 }}>
                    <option value="">—</option>
                    <option value="hours">hours</option>
                    <option value="km">km</option>
                  </select>
                </div>
              </div>
            </div>
            <div>
              <label className="lbl" htmlFor="notes">Notes</label>
              <input className="inp" id="notes" name="notes" defaultValue={a.notes ?? ''} />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Where it is</div>
              <div className="card-s">
                Moving an asset between sites should normally go through a transfer, so both
                ends confirm it. Change it here only to correct a mistake.
              </div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="location">Location</label>
              <select className="inp" id="location" name="location" defaultValue={a.location_id ?? ''}>
                {(locs ?? []).map((l: any) => (
                  <option key={l.id} value={l.id}>{l.name}{l.kind === 'virtual' ? ' (virtual)' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="status">Status</label>
              <select className="inp" id="status" name="status" defaultValue={a.status}>
                <option value="active">In service</option>
                <option value="repair">In repair</option>
                <option value="idle">Unassigned</option>
                {canRetire && <option value="retired">Retired</option>}
              </select>
              {!canRetire && (
                <div className="hint">
                  Retiring takes it off every live register, so it needs a manager. Ask one
                  rather than working around it.
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href={`/assets/${a.id}`}>Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>Save changes</button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Every change writes a line in the audit log saying exactly what moved, with your
          name and the time against it.
        </p>
      </form>
    </Shell>
  );
}
