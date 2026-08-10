import Shell from '@/components/Shell';
import { sb, getSession, hasRole, logoUrl } from '@/lib/session';
import { updateCompany, closeCompany, saveTheme, saveLogo, saveViewPreferences } from '@/lib/actions';
import LogoUpload from './LogoUpload';

export const dynamic = 'force-dynamic';

// Every one carries white text at readable contrast. That is the constraint —
// the palette exists so nobody picks a colour that prints an unreadable waybill.
const PALETTE = [
  ['#0551BD', 'Nothing Missing blue'],
  ['#061F3E', 'Navy'],
  ['#0F7B6C', 'Deep green'],
  ['#B3541E', 'Burnt orange'],
  ['#7A1F5C', 'Plum'],
  ['#1D4ED8', 'Royal'],
  ['#0E7490', 'Teal'],
  ['#8A2020', 'Oxblood'],
];

const COLUMNS = [
  ['tag', 'Tag'],
  ['name', 'Asset'],
  ['category', 'Category'],
  ['location', 'Location'],
  ['status', 'Status'],
  ['holder', 'Assigned to'],
  ['serial', 'Serial'],
  ['acquired', 'Acquired'],
  ['cost', 'Purchase cost'],
];

export default async function Settings({
  searchParams,
}: { searchParams: { error?: string; saved?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: co } = await supabase
    .from('companies')
    .select('id, name, registration_no, address, phone, brand_hex, accent_hex, theme_mode, slug, logo_path, document_footer, show_logo_on_documents')
    .limit(1).maybeSingle();

  if (!co) {
    return (
      <Shell current="settings" title="Settings" subtitle="Company and appearance">
        <div className="card"><div className="empty"><h4>No company in scope</h4>
        <p>You are signed in but not a member of any company on this address.</p></div></div>
      </Shell>
    );
  }

  const c = co as any;
  const editable = hasRole(session, 'owner', 'admin');

  const { data: prefs } = await supabase
    .from('view_preferences')
    .select('landing, density, asset_columns, default_location, hide_retired')
    .eq('company_id', c.id).maybeSingle();
  const p = (prefs ?? {}) as any;
  const chosen: string[] = p.asset_columns?.length ? p.asset_columns : ['tag','name','category','location','status','holder'];

  const { data: locs } = await supabase
    .from('locations').select('id, name').is('archived_at', null).order('name');

  return (
    <Shell current="settings" title="Settings" subtitle="Company, appearance and your own view">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved.</p></div>}

      {/* ---- company profile ---- */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Company profile</div>
            <div className="card-s">This is what prints on every waybill you issue</div>
          </div>
        </div>
        <form action={updateCompany} style={{ padding: 20, display: 'grid', gap: 16 }}>
          <input type="hidden" name="id" value={c.id} />
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="name">Registered name</label>
              <input className="inp" id="name" name="name" defaultValue={c.name} disabled={!editable} required />
            </div>
            <div>
              <label className="lbl" htmlFor="rc">Registration number</label>
              <input className="inp" id="rc" name="rc" defaultValue={c.registration_no ?? ''} disabled={!editable} />
            </div>
            <div>
              <label className="lbl" htmlFor="phone">Phone</label>
              <input className="inp" id="phone" name="phone" defaultValue={c.phone ?? ''} disabled={!editable} />
            </div>
          </div>
          <div>
            <label className="lbl" htmlFor="address">Registered address</label>
            <input className="inp" id="address" name="address" defaultValue={c.address ?? ''} disabled={!editable} />
          </div>
          {editable && <div><button className="btn btn-p" type="submit">Save details</button></div>}
        </form>
      </div>

      {/* ---- logo ---- */}
      {editable && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Your logo</div>
              <div className="card-s">
                Appears in your sidebar and on your waybills — a document going to a
                checkpoint should carry your identity, not ours
              </div>
            </div>
          </div>
          <LogoUpload companyId={c.id} current={c.logo_path} action={saveLogo} />
        </div>
      )}

      {/* ---- theme ---- */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Colour</div>
            <div className="card-s">
              One colour, and everything else derives from it — tints, borders, document
              accents, the emails your staff receive
            </div>
          </div>
        </div>
        <form action={saveTheme} style={{ padding: 20, display: 'grid', gap: 18 }}>
          <div>
            <label className="lbl">Brand colour</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {PALETTE.map(([hex, label]) => (
                <label className="swatch" key={hex} title={label}>
                  <input type="radio" name="brand" value={hex}
                         defaultChecked={c.brand_hex?.toUpperCase() === hex.toUpperCase()}
                         disabled={!editable} />
                  <span style={{ background: hex }} />
                </label>
              ))}
            </div>
            <div className="hint">
              Every one of these carries white text at readable contrast. A colour of your
              own is accepted too, but one too pale for white text is refused — it would
              print a waybill nobody can read, and the first you would hear of it is a
              customer complaining.
            </div>
          </div>

          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="accent">Accent (optional)</label>
              <input className="inp mono" id="accent" name="accent" placeholder="#085ED5"
                     defaultValue={c.accent_hex ?? ''} disabled={!editable} />
              <div className="hint">Used for secondary chart series. Leave blank to derive it.</div>
            </div>
            <div>
              <label className="lbl" htmlFor="mode">Interface</label>
              <select className="inp" id="mode" name="mode" defaultValue={c.theme_mode} disabled={!editable}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
          </div>

          <div>
            <label className="lbl" htmlFor="footer">Waybill footer</label>
            <input className="inp" id="footer" name="footer" defaultValue={c.document_footer ?? ''}
                   placeholder="Goods received in good order unless noted overleaf"
                   disabled={!editable} />
          </div>

          <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" name="show_logo" defaultChecked={c.show_logo_on_documents} disabled={!editable} />
            Show the logo on waybills and printed documents
          </label>

          {editable
            ? <div><button className="btn btn-p" type="submit">Save appearance</button></div>
            : <p className="hint">Only an owner or admin can change how the company looks.</p>}
        </form>
      </div>

      {/* ---- personal view ---- */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Your view</div>
            <div className="card-s">
              Yours alone — nobody else in the company sees or can change these, including
              an owner
            </div>
          </div>
        </div>
        <form action={saveViewPreferences} style={{ padding: 20, display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="landing">Open on</label>
              <select className="inp" id="landing" name="landing" defaultValue={p.landing ?? 'dashboard'}>
                <option value="dashboard">Dashboard</option>
                <option value="assets">Asset register</option>
                <option value="transfers">Transfers</option>
                <option value="submissions">Field inbox</option>
                <option value="inventory">Inventory</option>
              </select>
              <div className="hint">Where signing in takes you.</div>
            </div>
            <div>
              <label className="lbl" htmlFor="density">Table density</label>
              <select className="inp" id="density" name="density" defaultValue={p.density ?? 'comfortable'}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact — more rows on screen</option>
              </select>
            </div>
            <div>
              <label className="lbl" htmlFor="default_location">Default location</label>
              <select className="inp" id="default_location" name="default_location"
                      defaultValue={p.default_location ?? ''}>
                <option value="">All locations</option>
                {(locs ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
              <div className="hint">If you only ever look at one site.</div>
            </div>
          </div>

          <div>
            <label className="lbl">Columns on the register</label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {COLUMNS.map(([id, label]) => (
                <label key={id} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" name="column" value={id} defaultChecked={chosen.includes(id)} />
                  {label}
                </label>
              ))}
            </div>
            <div className="hint">
              Purchase cost only appears if your role can see it — ticking it does not grant
              anything, the database still decides.
            </div>
          </div>

          <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" name="hide_retired" defaultChecked={p.hide_retired ?? true} />
            Hide retired assets from the register
          </label>

          <div><button className="btn btn-p" type="submit">Save my view</button></div>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div><div className="card-t">Your address</div>
          <div className="card-s">Where your team signs in, and where your field links point</div></div>
        </div>
        <div style={{ padding: 20 }}>
          <div className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{c.slug}.nothingmissing.ng</div>
          <p className="hint">
            Set once and not changeable from here. Changing it would break every link already
            shared, every bookmark, and every waybill footer already printed.
          </p>
        </div>
      </div>

      {hasRole(session, 'owner') && (
        <div className="card" style={{ borderColor: 'var(--bad-soft)' }}>
          <div className="card-h bd">
            <div>
              <div className="card-t" style={{ color: 'var(--bad)' }}>Close this company</div>
              <div className="card-s">It archives rather than deletes, and that is deliberate</div>
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.65, maxWidth: '62ch' }}>
              Closing revokes every field link immediately and retires your address, so nobody
              else can claim a URL whose links are still sitting in people&rsquo;s phones. The
              register, the audit trail and everyone&rsquo;s submissions are kept — other
              people&rsquo;s work is not yours to erase, and a dispute six months from now will
              need them.
            </p>
            <form action={closeCompany} style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input className="inp" name="confirm" placeholder={`Type "${c.name}" to confirm`}
                     style={{ flex: 1, minWidth: 220 }} />
              <button className="btn btn-g" type="submit" style={{ color: 'var(--bad)', borderColor: 'var(--bad-soft)' }}>
                Close the company
              </button>
            </form>
          </div>
        </div>
      )}
    </Shell>
  );
}
