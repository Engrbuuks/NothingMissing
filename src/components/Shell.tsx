import { redirect } from 'next/navigation';
import { getSession, canSeeFinancials, type Session } from '@/lib/session';

const NAV = [
  { g: 'Menu' },
  { id: 'assets', label: 'Assets', href: '/assets' },
  { id: 'diagnostics', label: 'Diagnostics', href: '/diagnostics' },
];

const initials = (s: string) =>
  s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

export default async function Shell({
  current,
  title,
  subtitle,
  children,
}: {
  current: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  // Signed in, but with no membership at this company. Not a filtered view —
  // there is genuinely nothing here for them, and saying so is kinder than an
  // empty table that looks like a bug.
  if (session.tenant && !session.role) {
    return (
      <main className="wrap" style={{ paddingTop: 80, maxWidth: 560 }}>
        <h1 style={{ fontSize: 24 }}>No access to {session.tenant.name}</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          You are signed in as <b>{session.email}</b>, but that account is not a member of
          this company. If you should be, ask an owner or admin there to invite you.
        </p>
        <form action="/auth/sign-out" method="post" style={{ marginTop: 20 }}>
          <button className="btn btn-g" type="submit">Sign out</button>
        </form>
      </main>
    );
  }

  const t = session.tenant;
  const brand = t?.brand_hex ?? '#5B4BE8';
  const scope =
    session.scopedLocationIds.length === 0
      ? 'All locations'
      : `${session.scopedLocationIds.length} location${session.scopedLocationIds.length === 1 ? '' : 's'}`;

  return (
    <>
      {/* The tenant's own colour, set as an inline custom property on the
          shell rather than an injected <style> tag. Same effect — every token
          that references var(--brand) picks it up — without handing a
          database value to the CSS parser as raw text. */}
      <div
        className="shell"
        style={{ ['--brand' as string]: brand, ['--brand-soft' as string]: `${brand}1A` } as React.CSSProperties}
      >
        <aside className="side">
          <div className="brand">
            <span className="brand-mark">{t ? initials(t.name) : 'NM'}</span>
            <div>
              <div className="brand-name">{t?.name ?? 'Nothing Missing'}</div>
              <div className="brand-sub">Asset control</div>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n, i) =>
              n.g ? (
                <div className="nav-label" key={i}>{n.g}</div>
              ) : (
                <a key={n.id} href={n.href} className={`nav-item ${current === n.id ? 'on' : ''}`}>
                  {n.label}
                </a>
              )
            )}
          </nav>
          <div className="side-foot">
            <div className="side-user">
              <span className="av">{initials(session.fullName ?? session.email)}</span>
              <span>
                <span className="side-user-n">{session.fullName ?? session.email}</span>
                <br />
                <span className="side-user-r">
                  {session.role} · {scope}
                </span>
              </span>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="top">
            <div>
              <div className="pt">{title}</div>
              {subtitle && <div className="pt-sub">{subtitle}</div>}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="pill p-mute">{scope}</span>
              {!canSeeFinancials(session) && (
                <span className="pill p-mute" title="Purchase costs are not visible to your role">
                  Costs hidden
                </span>
              )}
              <form action="/auth/sign-out" method="post">
                <button className="btn btn-g" type="submit">Sign out</button>
              </form>
            </div>
          </header>
          <section className="view">{children}</section>
        </div>
      </div>
    </>
  );
}
