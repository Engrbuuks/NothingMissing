import { redirect } from 'next/navigation';
import { getSession, sb } from '@/lib/session';
import { createCompanyAccount } from '@/lib/actions';

export const dynamic = 'force-dynamic';

export default async function Onboarding({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  // Someone who already owns a company should not be able to wander back here
  // and accidentally create a second one.
  const { data: existing } = await sb()
    .from('memberships')
    .select('company_id, companies ( slug, name )')
    .eq('role', 'owner')
    .limit(1);

  const owned = (existing ?? [])[0] as any;

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 480 }}>
        <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 14, fontSize: 15, marginBottom: 22 }}>NM</div>
        <h1 style={{ fontSize: 25 }}>Name your company</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7, lineHeight: 1.6 }}>
          This creates your register, your virtual warehouse, and the address your team
          signs in at.
        </p>

        {owned && (
          <div className="notice" style={{ marginTop: 18 }}>
            <p>
              You already own <b>{owned.companies?.name}</b>.{' '}
              <a href={`https://${owned.companies?.slug}.nothingmissing.ng`} style={{ textDecoration: 'underline' }}>
                Go there
              </a>{' '}
              — or fill this in to start a second one.
            </p>
          </div>
        )}

        {searchParams.error && (
          <div className="notice bad" style={{ marginTop: 18 }}><p>{searchParams.error}</p></div>
        )}

        <form action={createCompanyAccount} style={{ marginTop: 20 }}>
          <label className="lbl" htmlFor="company">Registered company name</label>
          <input className="inp" id="company" name="company" required placeholder="e.g. Zenith Facilities Ltd" />

          <div style={{ height: 16 }} />
          <label className="lbl" htmlFor="slug">Your address</label>
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--surface)' }}>
            <input className="inp" id="slug" name="slug" placeholder="zenith" autoCapitalize="off" spellCheck={false}
                   style={{ border: 'none', borderRadius: 0, flex: 1, minWidth: 0 }} />
            <span className="mono" style={{ padding: '0 13px', fontSize: 13.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
              .nothingmissing.ng
            </span>
          </div>
          <div className="hint">
            Leave it blank and we will derive one from the company name. It is set once and
            cannot be changed afterwards, because changing it would break every link already
            shared and every waybill already printed.
          </div>

          <div style={{ height: 16 }} />
          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <label className="lbl" htmlFor="rc">Registration number</label>
              <input className="inp" id="rc" name="rc" placeholder="RC 1234567" />
            </div>
            <div>
              <label className="lbl" htmlFor="name">Your name</label>
              <input className="inp" id="name" name="name" defaultValue={session.fullName ?? ''} />
            </div>
          </div>

          <div style={{ height: 14 }} />
          <label className="lbl" htmlFor="address">Head office address</label>
          <input className="inp" id="address" name="address" />
          <div className="hint">This is what prints on your waybills.</div>

          <div style={{ height: 22 }} />
          <button className="btn btn-p btn-lg" type="submit">Create the company</button>
        </form>
      </div>
    </main>
  );
}
