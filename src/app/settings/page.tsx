import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { updateCompany, closeCompany } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const PALETTE = ['#5B4BE8','#0F7B6C','#C2410C','#1D4ED8','#B91C6B','#111827','#0E7490','#A16207'];

export default async function Settings({
  searchParams,
}: { searchParams: { error?: string; saved?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: co } = await supabase
    .from('companies')
    .select('id, name, registration_no, address, phone, brand_hex, slug')
    .limit(1).maybeSingle();

  if (!co) {
    return (
      <Shell current="settings" title="Settings" subtitle="Company profile and branding">
        <div className="card"><div className="empty"><h4>No company in scope</h4>
        <p>You are signed in but not a member of any company on this address.</p></div></div>
      </Shell>
    );
  }

  const c = co as any;
  const editable = hasRole(session, 'owner', 'admin');

  return (
    <Shell current="settings" title="Settings" subtitle="Company profile and branding">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved. Documents issued from now on carry these details.</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Company profile</div>
            <div className="card-s">This is what prints on every waybill you issue</div>
          </div>
        </div>
        <form action={updateCompany} style={{ padding: 20, display: 'grid', gap: 16 }}>
          <input type="hidden" name="id" value={c.id} />

          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
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

          <div>
            <label className="lbl">Brand colour</label>
            {/* One colour, and everything else derives from it. A company given
                six pickers produces documents you would be embarrassed to have
                your name on. */}
            <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
              {PALETTE.map((hex) => (
                <label key={hex} style={{ cursor: editable ? 'pointer' : 'default' }}>
                  <input
                    type="radio"
                    name="brand"
                    value={hex}
                    defaultChecked={c.brand_hex === hex}
                    disabled={!editable}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                  <span
                    style={{
                      display: 'block', width: 38, height: 38, borderRadius: 11,
                      background: hex,
                      outline: c.brand_hex === hex ? '2.5px solid var(--text)' : '2.5px solid transparent',
                      outlineOffset: 2,
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="hint">
              Everything else — tints, borders, document accents, the emails your staff
              receive — is derived from this one value, so a company can never produce a
              waybill that is unreadable in print.
            </div>
          </div>

          {editable ? (
            <div><button className="btn btn-p" type="submit">Save changes</button></div>
          ) : (
            <p className="hint">Only an owner or admin can change these.</p>
          )}
        </form>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div><div className="card-t">Your address</div>
          <div className="card-s">Where your team signs in, and where your field links point</div></div>
        </div>
        <div style={{ padding: 20 }}>
          <div className="mono" style={{ fontSize: 15, fontWeight: 700 }}>
            {c.slug}.nothingmissing.ng
          </div>
          <p className="hint">
            Set once and not changeable from here. Changing it would break every link
            already shared, every bookmark, and every waybill footer already printed.
          </p>
        </div>
      </div>
      {hasRole(session, 'owner') && (
        <div className="card" style={{ borderColor: 'var(--bad-soft)' }}>
          <div className="card-h bd">
            <div>
              <div className="card-t" style={{ color: 'var(--bad)' }}>Close this company</div>
              <div className="card-s">
                It archives rather than deletes, and that is deliberate
              </div>
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