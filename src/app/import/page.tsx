import Shell from '@/components/Shell';
import { sb, getSession, canWrite } from '@/lib/session';
import { previewBranchImport, previewStockImport } from '@/lib/actions';
import CsvFile from './CsvFile';

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
}: { searchParams: { error?: string; kind?: string } }) {
  const stock = searchParams.kind === 'stock';
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

  if (stock) return <StockImport error={searchParams.error} sites={sites} />;

  return (
    <Shell current="import" title="Add a branch" subtitle="Paste a spreadsheet, everything else builds itself">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <div className="segmented" style={{ marginBottom: 16 }}>
        <a className="on" href="/import">Assets</a>
        <a href="/import?kind=stock">Inventory</a>
      </div>

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
              <div className="card-t">Your rows</div>
              <div className="card-s">
                Choose a CSV file, or select the cells in Excel or Google Sheets including the
                header row and paste. Tabs and commas both work.
              </div>
            </div>
            <a className="btn btn-g" href="/import/template?kind=assets" style={{ marginLeft: 'auto' }}>
              Download a template
            </a>
          </div>
          <div style={{ padding: 20 }}>
            <CsvFile target="sheet" />
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

/**
 * Importing inventory.
 *
 * Same shape as the asset import on purpose. Somebody who has done one should
 * not have to learn the other, and the two step preview exists for the same
 * reason in both: committing four hundred rows and finding out afterwards that
 * a column was misread is not recoverable by hand.
 */
function StockImport({ error, sites }: { error?: string; sites: any[] }) {
  return (
    <Shell current="import" title="Import inventory" subtitle="Paste a stock list, counted things rather than tagged ones">
      {error && <div className="notice bad"><p>{error}</p></div>}

      <div className="segmented" style={{ marginBottom: 16 }}>
        <a href="/import">Assets</a>
        <a className="on" href="/import?kind=stock">Inventory</a>
      </div>

      <div className="notice">
        <p>
          <b>Inventory is the countable stuff.</b> Diesel, filters, cable, gloves: things where
          only the total matters and one is interchangeable with any other. Anything you would
          ever ask &ldquo;where is that specific one?&rdquo; about belongs on the asset import
          instead, where it keeps its own history.
        </p>
      </div>

      <form action={previewStockImport}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Where it is held</div>
              <div className="card-s">An existing store, or a new one created from this name</div>
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <label className="lbl" htmlFor="where">Location</label>
            <input className="inp" id="where" name="where" list="stock-sites" required
                   placeholder="e.g. Ibadan Store" />
            <datalist id="stock-sites">
              {sites.map((l) => <option key={l.id} value={l.name} />)}
            </datalist>
            <div className="hint">
              Opening quantities are received into this location, so they appear in the ledger
              with a date against them rather than simply existing.
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Your rows</div>
              <div className="card-s">
                Choose a CSV file, or paste straight out of Excel or Google Sheets with the
                header row included. Tabs and commas both work.
              </div>
            </div>
            <a className="btn btn-g" href="/import/template?kind=stock" style={{ marginLeft: 'auto' }}>
              Download a template
            </a>
          </div>
          <div style={{ padding: 20 }}>
            <CsvFile target="sheet" />
            <textarea
              className="inp mono"
              name="sheet"
              rows={12}
              required
              style={{ fontSize: 12.5, lineHeight: 1.6, resize: 'vertical' }}
              placeholder={`Item,SKU,Category,Unit,Quantity,Reorder Level,Unit Cost
Diesel,DSL-001,Fuel,litres,3000,500,1250
Engine oil 20W50,OIL-20W50,Consumables,litres,180,40,4800
Air filter,FLT-AIR-01,Spares,units,24,6,8500
Safety helmet,PPE-HLM,Safety,units,40,10,6500`}
            />

            <div className="cols">
              <div>
                <h4>The only column you must have</h4>
                <p><span className="mono">Item</span> or <span className="mono">Name</span>, what the thing is.</p>
              </div>
              <div>
                <h4>Everything else is optional</h4>
                <p>
                  <span className="mono">SKU</span>, <span className="mono">Category</span>,{' '}
                  <span className="mono">Unit</span>, <span className="mono">Quantity</span>,{' '}
                  <span className="mono">Reorder Level</span>, <span className="mono">Unit Cost</span>.
                  Give what you have.
                </p>
              </div>
              <div>
                <h4>Headers can be named your way</h4>
                <p>
                  <span className="mono">Qty</span>, <span className="mono">Quantity</span> and{' '}
                  <span className="mono">On Hand</span> all read as the opening balance. So do{' '}
                  <span className="mono">UOM</span> and <span className="mono">Unit of Measure</span>,{' '}
                  <span className="mono">Part No.</span> and <span className="mono">Item Code</span>.
                </p>
              </div>
              <div>
                <h4>No code? No problem</h4>
                <p>
                  A SKU is generated from the name for any row without one. A code that already
                  exists is left alone and reported, so running the same file twice cannot
                  double your balances.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a className="btn btn-g" href="/inventory">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>
            Preview the import
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Nothing is written yet. The next screen shows exactly what would be created.
        </p>
      </form>
    </Shell>
  );
}
