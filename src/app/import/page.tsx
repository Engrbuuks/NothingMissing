import Shell from '@/components/Shell';
import { sb, getSession, canWrite } from '@/lib/session';
import { previewBranchImport } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Bringing a branch onto the register.
 *
 * The old version needed a location to already exist, took three columns, and
 * committed straight from the paste box. That meant five screens of setup
 * before a single asset could be entered, which is where people gave up.
 *
 * Now: paste, preview, confirm. The location, categories, brands and catalog
 * models are created from what the file says.
 */
export default async function Import({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  const { data: locations } = await sb()
    .from('locations').select('id, name, kind').is('archived_at', null).order('name');

  const sites = ((locations ?? []) as any[]).filter((l) => l.kind !== 'virtual');

  if (!canWrite(session)) {
    return (
      <Shell current="import" title="Import" subtitle="Bring a branch onto the register">
        <div className="card"><div className="empty"><h4>Not available to your role</h4>
        <p>Importing writes to the register, which your role does not permit.</p></div></div>
      </Shell>
    );
  }

  return (
    <Shell current="import" title="Add a branch" subtitle="Paste a spreadsheet — everything else builds itself">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <div className="notice">
        <p>
          <b>You do not need to set anything up first.</b> Paste the rows and the branch, its
          categories, brands and catalog models are all created from what the file says. You
          will see exactly what will happen before anything is written.
        </p>
      </div>

      <form action={previewBranchImport}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Which branch</div>
              <div className="card-s">A new site, or one already on the system</div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="branch">New branch name</label>
                <input className="inp" id="branch" name="branch" placeholder="e.g. Abuja Branch" />
                <div className="hint">Leave blank if you are adding to a site below.</div>
              </div>
              <div>
                <label className="lbl" htmlFor="city">City</label>
                <input className="inp" id="city" name="city" placeholder="Abuja" />
              </div>
              <div>
                <label className="lbl" htmlFor="existing">…or an existing site</label>
                <select className="inp" id="existing" name="existing" defaultValue="">
                  <option value="">Create a new branch</option>
                  {sites.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Paste your rows</div>
              <div className="card-s">
                Straight out of Excel or Google Sheets — select the cells including the header
                row and paste. Tabs and commas both work.
              </div>
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <textarea
              className="inp mono"
              name="sheet"
              rows={12}
              required
              style={{ fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
              placeholder={`Name,Serial No.,Category,Type,Make,Model,Assigned To,Purchase Cost
Lenovo AIO,SN-4471,IT equipment,Desktop computer,Lenovo,ThinkCentre M90a,Reception,480000
Lenovo AIO,SN-4472,IT equipment,Desktop computer,Lenovo,ThinkCentre M90a,Accounts,480000
Task chair,,Furniture,Seating,Ergo,Mesh Task,,42000
Meeting table,,Furniture,Tables,Ergo,6-seater Oak,Boardroom,185000`}
            />

            <div className="cols">
              <div>
                <h4>The only column you must have</h4>
                <p><span className="mono">Name</span> — what the thing is.</p>
              </div>
              <div>
                <h4>Everything else is optional</h4>
                <p>
                  <span className="mono">Serial</span>, <span className="mono">Category</span>,
                  {' '}<span className="mono">Type</span>, <span className="mono">Make</span>,
                  {' '}<span className="mono">Model</span>, <span className="mono">Assigned To</span>,
                  {' '}<span className="mono">Purchase Cost</span>,{' '}
                  <span className="mono">Date</span>. Give what you have.
                </p>
              </div>
              <div>
                <h4>Headers can be named your way</h4>
                <p>
                  <span className="mono">S/N</span>, <span className="mono">Serial No.</span> and
                  {' '}<span className="mono">Serial Number</span> are all understood. So are
                  {' '}<span className="mono">Make</span> and <span className="mono">Manufacturer</span>,
                  {' '}<span className="mono">Description</span> and <span className="mono">Item</span>.
                </p>
              </div>
              <div>
                <h4>No tag? No problem</h4>
                <p>
                  Asset tags are generated for any row without one, carrying on from your
                  existing numbering.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a className="btn btn-g" href="/assets">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>
            Preview the import
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Nothing is written until you confirm the preview.
        </p>
      </form>
    </Shell>
  );
}
