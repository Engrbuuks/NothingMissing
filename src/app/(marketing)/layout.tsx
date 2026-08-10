import Link from 'next/link';

/**
 * The marketing site, on the apex. A tenant lives at its own subdomain, so
 * nothing here shares a layout with the application — different audience,
 * different job.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt">
      <header className="mkt-nav">
        <div className="mkt-wrap">
          <a className="mkt-brand" href="/">
            <span className="brand-mark" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 12 }}>NM</span>
            <span>Nothing Missing</span>
          </a>
          <nav className="mkt-links">
            <a href="/pricing">Pricing</a>
            <a href="/security">Security</a>
            <a href="/about">About</a>
          </nav>
          <div className="mkt-cta">
            <a className="btn btn-g" href="/sign-in">Sign in</a>
            <a className="btn btn-p" href="/sign-up">Start free</a>
          </div>
        </div>
      </header>

      {children}

      <footer className="mkt-foot">
        <div className="mkt-wrap">
          <div>
            <div className="mkt-brand" style={{ marginBottom: 10 }}>
              <span className="brand-mark" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 11 }}>NM</span>
              <span>Nothing Missing</span>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 260, lineHeight: 1.6 }}>
              Asset and inventory management for companies running depots, branches and site
              offices. Lagos, Nigeria.
            </p>
          </div>
          <div className="mkt-foot-links">
            <a href="/pricing">Pricing</a>
            <a href="/security">Security</a>
            <a href="/about">About</a>
            <a href="/sign-in">Sign in</a>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
          </div>
        </div>
        <div className="mkt-wrap" style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 26 }}>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
            © {new Date().getFullYear()} Nothing Missing · nothingmissing.ng
          </p>
        </div>
      </footer>
    </div>
  );
}
