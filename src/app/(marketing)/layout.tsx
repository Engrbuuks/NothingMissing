import { Wordmark } from '@/components/Mark';

/**
 * The marketing site, on the apex. Deliberately not the application's visual
 * language: this is read once by a stranger deciding whether to trust us,
 * where the app is looked at every day by someone who already has.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt">
      <header className="mkt-nav">
        <div className="mkt-wrap">
          <a className="mkt-brand" href="/" aria-label="Nothing Missing">
            <Wordmark size={19} />
          </a>
          <nav className="mkt-links">
            <a href="/home">Overview</a>
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
          <div className="foot-grid">
            <div>
              <div style={{ marginBottom: 12 }}>
                <Wordmark size={18} />
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 280, lineHeight: 1.62 }}>
                Asset and inventory management for companies running depots, branches and
                site offices.
              </p>
              <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 12, lineHeight: 1.62 }}>
                Lagos, Nigeria
                <br />
                <a href="mailto:hello@nothingmissing.ng" style={{ color: 'var(--brand)' }}>
                  hello@nothingmissing.ng
                </a>
              </p>
            </div>

            <div className="foot-col">
              <h5>Product</h5>
              <a href="/home">Overview</a>
              <a href="/pricing">Pricing</a>
              <a href="/security">Security</a>
              <a href="/sign-up">Start free</a>
            </div>

            <div className="foot-col">
              <h5>Company</h5>
              <a href="/about">About</a>
              <a href="mailto:hello@nothingmissing.ng">Contact</a>
              <a href="/sign-in">Sign in</a>
            </div>

            <div className="foot-col">
              <h5>Legal</h5>
              <a href="/terms">Terms</a>
              <a href="/privacy">Privacy</a>
              <a href="/security">Data protection</a>
            </div>
          </div>
        </div>

        <div className="mkt-wrap" style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 30 }}>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
            © {new Date().getFullYear()} Nothing Missing · nothingmissing.ng
          </p>
        </div>
      </footer>
    </div>
  );
}
