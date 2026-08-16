import Shell from '@/components/Shell';
import { sb, getSession } from '@/lib/session';
import { updateMyProfile } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Your own profile.
 *
 * The name here is what appears in the sidebar, on approvals, and against every
 * audit row you write from now on. It deliberately does NOT rewrite rows already
 * written — the log should say who did something under the name they held at
 * the time, or a rename becomes a way to quietly edit history.
 */
export default async function Profile({
  searchParams,
}: { searchParams: { error?: string; saved?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email, phone, job_title')
    .eq('id', session?.userId ?? '')
    .maybeSingle();

  const p = (profile ?? {}) as any;

  return (
    <Shell current="settings" title="Your profile" subtitle="How you appear to everyone else">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved.</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Your details</div>
            <div className="card-s">
              This name appears in the sidebar, on approvals you give, and against everything
              you do from now on
            </div>
          </div>
        </div>
        <form action={updateMyProfile} style={{ padding: 20, display: 'grid', gap: 16 }}>
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}>
            <div>
              <label className="lbl" htmlFor="full_name">Full name</label>
              <input className="inp" id="full_name" name="full_name"
                     defaultValue={p.full_name ?? ''} required minLength={2} />
            </div>
            <div>
              <label className="lbl" htmlFor="job_title">Job title</label>
              <input className="inp" id="job_title" name="job_title"
                     defaultValue={p.job_title ?? ''} placeholder="Operations Manager" />
            </div>
            <div>
              <label className="lbl" htmlFor="phone">Phone</label>
              <input className="inp" id="phone" name="phone" defaultValue={p.phone ?? ''}
                     placeholder="+234 802 441 0119" />
            </div>
          </div>

          <div>
            <label className="lbl">Email</label>
            <input className="inp" value={p.email ?? session?.email ?? ''} disabled />
            <div className="hint">
              This is how you sign in, so it cannot be changed here. Ask an owner to invite
              you at a new address if you need to move.
            </div>
          </div>

          <div><button className="btn btn-p" type="submit">Save</button></div>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Your data</div>
            <div className="card-s">
              Everything we hold about you, which the privacy notice says you can ask for
            </div>
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <a className="btn btn-g" href="/profile/export">Download my data</a>
          <p className="hint" style={{ marginTop: 10, maxWidth: '60ch' }}>
            Your profile, which companies you belong to and in what role, and what you have
            agreed to. Actions you took stay in each company&rsquo;s audit log — that record
            belongs to the company and is the basis of its asset register.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div><div className="card-t">What history keeps</div></div>
        </div>
        <div style={{ padding: 20 }}>
          <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.68, maxWidth: '64ch' }}>
            Changing your name here affects everything from now on. It does <b>not</b> rewrite
            audit rows already written — those keep the name you held when you did the thing
            they describe. That is deliberate: if a rename could rewrite the log, renaming
            would be a way to quietly edit history, and the log would stop being worth having.
          </p>
        </div>
      </div>
    </Shell>
  );
}
