import { redirect } from 'next/navigation';
import { sb, getSession, money } from '@/lib/session';
import { toggleBilling, setComped, provisionCompany } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * The platform view. Outside the tenant shell, because this is not a screen
 * inside anybody's company.
 *
 * It shows every company's name, size and plan — and nothing else. No register,
 * no people, no audit trail. The cross-tenant exception stays as narrow here as
 * it is for payments.
 */
export default async function AdminCompanies({
  searchParams,
}: { searchParams: { error?: string; saved?: string; created?: string } }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const supabase = sb();
  const { data: me } = await supabase.from('platform_reviewers').select('user_id').maybeSingle();

  if (!me) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '80px 24px' }}>
        <h1 style={{ fontSize: 23 }}>Not a reviewer</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          This page manages every company on the platform, and your account is not on the
          reviewer list. There is deliberately no screen for adding someone — it is a
          database action, because a button granting cross-tenant visibility is one somebody
          eventually clicks by mistake.
        </p>
        <a className="btn btn-g" href="/" style={{ marginTop: 20 }}>Back</a>
      </main>
    );
  }

  const [{ data: companies }, { data: settings }] = await Promise.all([
    supabase.rpc('platform_companies'),
    supabase.from('platform_settings').select('billing_enabled, free_notice').maybeSingle(),
  ]);

  const rows = (companies ?? []) as any[];
  const live = Boolean((settings as any)?.billing_enabled);
  const notice = (settings as any)?.free_notice ?? '';
  const totalAssets = rows.reduce((s, c) => s + Number(c.assets ?? 0), 0);

  return (
    <main className="wrap" style={{ padding: '32px 24px 70px', maxWidth: 1000 }}>
      <div style={{ marginBottom: 22 }}>
        <div className="pt">Companies</div>
        <div className="pt-sub">Every account on the platform, and what it pays</div>
        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          <a className="btn btn-g" href="/admin/payments">Payments awaiting confirmation</a>
        </div>
      </div>

      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved.</p></div>}
      {searchParams.created && (
        <div className="notice">
          <p>
            <b>Company created.</b> Send the owner to{' '}
            <a href={searchParams.created} className="mono" style={{ textDecoration: 'underline' }}>
              {searchParams.created}
            </a>{' '}
            — they sign in with the email you used, using the password set in Supabase.
          </p>
        </div>
      )}

      {/* ---- the switch ---- */}
      <div className="card" style={{ marginBottom: 18, borderColor: live ? 'var(--line)' : 'var(--warn-soft)' }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Billing</div>
            <div className="card-s">
              One switch for the whole platform. While it is off nothing is charged, nothing
              is restricted, and every billing screen says so plainly.
            </div>
          </div>
          <span className={`pill ${live ? 'p-ok' : 'p-warn'}`} style={{ marginLeft: 'auto' }}>
            <span className="pd" />{live ? 'Charging' : 'Free for everyone'}
          </span>
        </div>
        <form action={toggleBilling} style={{ padding: 20, display: 'grid', gap: 14 }}>
          <div>
            <label className="lbl" htmlFor="notice">What companies are told while it is free</label>
            <input className="inp" id="notice" name="notice" defaultValue={notice} />
            <div className="hint">
              Shown on every billing page. Say plainly that they will be warned before
              anything changes — a surprise invoice loses a customer permanently.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-g" type="submit" name="on" value="no" disabled={!live}>
              Keep it free
            </button>
            <button className="btn btn-p" type="submit" name="on" value="yes" disabled={live}>
              Start charging
            </button>
          </div>
          {!live && (
            <p className="hint">
              Turning this on does not charge anyone immediately — it makes the Pay button
              work and starts showing real amounts. Companies marked as having free access
              keep it.
            </p>
          )}
        </form>
      </div>

      {/* ---- create one by hand ---- */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Set up a company</div>
            <div className="card-s">
              For someone you have spoken to rather than someone who found the sign-up form
            </div>
          </div>
        </div>
        <div className="notice" style={{ margin: '16px 20px 0' }}>
          <p>
            <b>Create their login first.</b> Supabase → Authentication → Users → Add user,
            with their email and a password, and tick <b>Auto Confirm User</b> so they can
            sign in straight away. Then fill this in with the same email.
          </p>
        </div>
        <form action={provisionCompany} style={{ padding: 20, display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="email">Owner&rsquo;s email</label>
              <input className="inp" id="email" name="email" type="email" required
                     placeholder="Must match the account you created" />
            </div>
            <div>
              <label className="lbl" htmlFor="name">Owner&rsquo;s name</label>
              <input className="inp" id="name" name="name" required />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="company">Company name</label>
              <input className="inp" id="company" name="company" required placeholder="Zenith Facilities Ltd" />
            </div>
            <div>
              <label className="lbl" htmlFor="slug">Address</label>
              <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--line)',
                            borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>
                <input className="inp" id="slug" name="slug" placeholder="zenith"
                       autoCapitalize="off" spellCheck={false}
                       style={{ border: 'none', borderRadius: 0, flex: 1, minWidth: 0 }} />
                <span className="mono" style={{ padding: '0 12px', fontSize: 12.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                  .nothingmissing.ng
                </span>
              </div>
              <div className="hint">Leave blank to derive it from the company name.</div>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="rc">Registration number</label>
              <input className="inp" id="rc" name="rc" placeholder="RC 1234567" />
            </div>
            <div>
              <label className="lbl" htmlFor="address">Head office address</label>
              <input className="inp" id="address" name="address" />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 9, alignItems: 'center', fontSize: 13.5 }}>
              <input type="checkbox" name="comped" defaultChecked />
              Free access, kept even after billing starts
            </label>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label className="lbl" htmlFor="reason">Why</label>
              <input className="inp" id="reason" name="reason" defaultValue="Early customer" />
            </div>
          </div>

          <div><button className="btn btn-p" type="submit">Create the company</button></div>
        </form>
      </div>

      {/* ---- everyone ---- */}
      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} compan{rows.length === 1 ? 'y' : 'ies'}</div>
            <div className="card-s">{totalAssets.toLocaleString()} assets across all of them</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty"><h4>Nobody yet</h4><p>Companies appear here as they sign up or are set up.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Company</th><th>Assets</th><th>People</th><th>Plan</th><th>Last active</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="aname">{c.name}</div>
                      <div className="amake"><span className="tag">{c.slug}.nothingmissing.ng</span></div>
                    </td>
                    <td className="mono">{c.assets}</td>
                    <td className="mono">{c.people}</td>
                    <td>
                      {c.comped ? (
                        <>
                          <span className="pill p-ok"><span className="pd" />Free</span>
                          {c.comped_reason && <div className="amake" style={{ marginTop: 4 }}>{c.comped_reason}</div>}
                        </>
                      ) : (
                        <span className="pill p-mute"><span className="pd" />{c.tier}</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--text-2)', fontSize: 12.5 }}>
                      {c.last_activity ? new Date(c.last_activity).toLocaleDateString('en-GB') : 'never'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <form action={setComped} style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <input type="hidden" name="company" value={c.id} />
                        <input type="hidden" name="reason" value={c.comped_reason ?? 'Early customer'} />
                        <button className="btn btn-g" type="submit" name="on" value={c.comped ? 'no' : 'yes'}>
                          {c.comped ? 'End free access' : 'Give free access'}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
