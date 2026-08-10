export const metadata = { title: 'Pricing — Nothing Missing' };

export default function Pricing() {
  return (
    <>
      <section className="mkt-hero" style={{ paddingBottom: 40 }}>
        <div className="mkt-wrap">
          <span className="mkt-eyebrow">Pricing</span>
          <h1 style={{ fontSize: 38 }}>Priced per asset, because that is what it costs us.</h1>
          <p className="mkt-lead">
            No per-seat charge. Your storekeepers, drivers and site crew use links rather than
            accounts — charging for them would push you towards fewer people recording things,
            which is the opposite of the point.
          </p>
        </div>
      </section>

      <section className="mkt-wrap" style={{ padding: '0 24px 60px' }}>
        <div className="mkt-price-grid">
          {[
            { n: 'Starter', p: 'Free', s: 'Up to 50 assets', f: ['One location', 'Full audit trail', 'Field links', 'CSV import and export'], cta: 'Start free', hot: false },
            { n: 'Standard', p: '₦180', s: 'per asset, per month', f: ['Unlimited locations', 'Approval chains', 'Waybills and discrepancies', 'Maintenance scheduling', 'Unlimited people'], cta: 'Start free', hot: true },
            { n: 'Enterprise', p: 'Talk to us', s: 'Over 2,000 assets', f: ['Everything in Standard', 'Your own domain', 'Onboarding and data migration', 'Priority support'], cta: 'Get in touch', hot: false },
          ].map((t) => (
            <div className={`mkt-price ${t.hot ? 'hot' : ''}`} key={t.n}>
              {t.hot && <span className="mkt-price-tag">Most companies</span>}
              <h3>{t.n}</h3>
              <div className="mkt-price-v">{t.p}</div>
              <div className="mkt-price-s">{t.s}</div>
              <ul>{t.f.map((f) => <li key={f}>{f}</li>)}</ul>
              <a className={`btn ${t.hot ? 'btn-p' : 'btn-g'}`} href="/sign-up" style={{ width: '100%' }}>{t.cta}</a>
            </div>
          ))}
        </div>

        <div className="mkt-card" style={{ marginTop: 34 }}>
          <h3>Being straight about this number</h3>
          <p>
            ₦180 per asset per month is where we have started, not where we have landed. For a
            company with 2,800 assets that is ₦504,000 a month, and whether that reads as
            obvious value or as absurd depends entirely on what those assets are worth and how
            often they go astray.
          </p>
          <p style={{ marginTop: 12 }}>
            If it is wrong for your situation, tell us. We would rather price something
            correctly than lose a customer to a number we picked before we had met them.
          </p>
        </div>
      </section>
    </>
  );
}
