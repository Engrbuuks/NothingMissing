import { createClient } from '@supabase/supabase-js';
import { getSession } from '@/lib/session';
import { acceptInvitation } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'app' }, auth: { persistSession: false } }
  );

export default async function Join({
  params, searchParams,
}: { params: { token: string }; searchParams: { error?: string } }) {
  // Previewed without a session, so the page can be branded before sign-in.
  // It returns the company name and nothing else.
  const { data: inv } = await anon().rpc('invitation_preview', { p_token: params.token });
  const session = await getSession();

  if (!inv?.valid) {
    return (
      <main style={{ maxWidth: 460, margin: '0 auto', padding: '80px 24px' }}>
        <h1 style={{ fontSize: 23 }}>This invitation is not valid</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 14, lineHeight: 1.65 }}>
          It may have expired, been used already, or been withdrawn. Ask whoever sent it for
          a new one.
        </p>
        <a className="btn btn-g" href="/sign-in" style={{ marginTop: 22 }}>Sign in</a>
      </main>
    );
  }

  const wrongAccount = session && session.email.toLowerCase() !== String(inv.email).toLowerCase();

  return (
    <main style={{ maxWidth: 460, margin: '0 auto', padding: '72px 24px' }}>
      <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 14, fontSize: 15, marginBottom: 22 }}>NM</div>
      <h1 style={{ fontSize: 25 }}>Join {inv.company}</h1>
      <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
        You have been invited as <b>{inv.role}</b>
        {inv.location ? <> at <b>{inv.location}</b></> : <>, covering all locations</>}.
      </p>

      {searchParams.error && (
        <div className="notice bad" style={{ marginTop: 18 }}><p>{searchParams.error}</p></div>
      )}

      {!session ? (
        <>
          <div className="notice" style={{ marginTop: 18 }}>
            <p>
              Sign in as <b>{inv.email}</b> to accept. If you have no account yet, create one
              with that address and come back to this link.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <a className="btn btn-p" href="/sign-in">Sign in</a>
            <a className="btn btn-g" href="/sign-up">Create an account</a>
          </div>
        </>
      ) : wrongAccount ? (
        <div className="notice warn" style={{ marginTop: 18 }}>
          <p>
            This invitation was sent to <b>{inv.email}</b>, but you are signed in as{' '}
            <b>{session.email}</b>. An invitation is bound to the address it was sent to, so
            a forwarded link cannot let someone else in.
          </p>
        </div>
      ) : (
        <form action={acceptInvitation} style={{ marginTop: 22 }}>
          <input type="hidden" name="token" value={params.token} />
          <button className="btn btn-p btn-lg" type="submit">Accept and join</button>
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 14, lineHeight: 1.6 }}>
            Accepting is recorded in the company&rsquo;s audit log with your name and the time.
          </p>
        </form>
      )}
    </main>
  );
}
