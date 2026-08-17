import { redirect } from 'next/navigation';
import { sb, getSession } from '@/lib/session';
import { Wordmark } from '@/components/Mark';
import { acceptMyInvitation } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Where everybody goes after authenticating.
 *
 * Sign-in used to send people to '/', which on the apex has no tenant and
 * redirects to the marketing site — so a signed-in owner ended up looking at a
 * page inviting them to start free. Three screens each worked out the
 * destination separately, and one of them got it wrong.
 *
 * Now there is one answer, from one database function, used by sign-in, the
 * auth callback and the apex root alike.
 */
export default async function Landing({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const { data } = await sb().rpc('where_do_i_go');
  const d = (data ?? {}) as any;
  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';

  // A tenant lives on its own origin, so this is a hard navigation.
  if (d.destination === 'company' && d.slug) {
    redirect(`https://${d.slug}.${root}/`);
  }
  if (d.destination === 'onboarding') redirect('/onboarding');
  if (d.destination === 'sign_in') redirect('/sign-in');

  // An invitation outranks everything: somebody who was invited and then
  // signed up is trying to join a company, not found one.
  if (d.destination === 'invitation') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ marginBottom: 22 }}><Wordmark size={22} /></div>
          <h1 style={{ fontSize: 25 }}>Join {d.company}</h1>
          {searchParams.error && (
            <div className="notice bad" style={{ marginTop: 16 }}><p>{searchParams.error}</p></div>
          )}
          <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
            You were invited as <b>{d.role}</b>. Accepting adds you to their register — you
            are not creating a company of your own.
          </p>

          <form action={acceptMyInvitation} style={{ marginTop: 22 }}>
            <button className="btn btn-p btn-lg" type="submit">Accept and join {d.company}</button>
          </form>

          <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 16, lineHeight: 1.6 }}>
            Accepting is recorded in their audit log with your name and the time. If you
            meant to start your own company instead,{' '}
            <a href="/onboarding" style={{ textDecoration: 'underline' }}>do that here</a>.
          </p>
        </div>
      </main>
    );
  }

  // More than one company: they choose. Guessing sends somebody to the register
  // of a company they were not thinking about.
  const companies = (d.companies ?? []) as any[];
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 440 }}>
        <div style={{ marginBottom: 22 }}><Wordmark size={22} /></div>
        <h1 style={{ fontSize: 25 }}>Which company</h1>
        {searchParams.error && (
          <div className="notice bad" style={{ marginTop: 16 }}><p>{searchParams.error}</p></div>
        )}
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7 }}>
          You belong to {companies.length}.
        </p>

        <div style={{ display: 'grid', gap: 10, marginTop: 22 }}>
          {companies.map((c) => (
            <a key={c.slug} className="card"
               href={`https://${c.slug}.${root}/`}
               style={{ padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="aname" style={{ display: 'block' }}>{c.name}</span>
                <span className="amake">{c.slug}.{root} · {c.role}</span>
              </span>
              <span style={{ color: 'var(--brand)' }}>→</span>
            </a>
          ))}
        </div>
      </div>
    </main>
  );
}
