export const metadata = { title: 'Security — Nothing Missing' };

const POINTS: [string, string][] = [
  ['Row-level security on every table',
   'Every row carries the company it belongs to, and every query is filtered by the database against your membership. A query written next year by someone who has never heard of this still returns only your rows.'],
  ['Tested before the second table existed',
   'A test signs in as one company and asserts it can read nothing belonging to another — every table, every function. It runs on every change, and a failure stops the release.'],
  ['An append-only audit log',
   'There is no update or delete permission on it. Not for you, not for us. Even the database owner is stopped by a trigger. The only way to correct a mistake is to write another event saying so.'],
  ['Costs behind their own permission',
   'Purchase prices live in a separate table with its own rule. A location manager asking for an asset receives no financial data at all — not blanked, absent.'],
  ['Field links grant almost nothing',
   'A link is stored hashed, expires, has a submission ceiling, and can be revoked instantly. It cannot read the register, see costs, or reach another site. Everything it submits waits for a manager.'],
  ['Every company on its own address',
   'zenith.nothingmissing.ng is a separate browser origin from any other customer. Cookies and stored sessions cannot cross between them — the browser enforces that before our code runs.'],
];

export default function Security() {
  return (
    <>
      <section className="mkt-hero" style={{ paddingBottom: 40 }}>
        <div className="mkt-wrap">
          <span className="mkt-eyebrow">Security</span>
          <h1 style={{ fontSize: 38 }}>Your data is separated by the database, not by our code.</h1>
          <p className="mkt-lead">
            The difference matters. Application code has bugs, and a forgotten filter shows one
            customer another customer&rsquo;s register. We put the separation a layer lower,
            where forgetting it returns nothing rather than everything.
          </p>
        </div>
      </section>

      <section className="mkt-wrap" style={{ padding: '0 24px 70px' }}>
        <div className="mkt-grid">
          {POINTS.map(([t, d]) => (
            <div className="mkt-card" key={t}><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>

        <div className="mkt-card" style={{ marginTop: 26 }}>
          <h3>What we have not done yet</h3>
          <p>
            We are not SOC 2 certified and we do not claim to be. There is no third-party
            penetration test on file. Data is hosted with Supabase on AWS, and the backups are
            theirs rather than ours.
          </p>
          <p style={{ marginTop: 12 }}>
            If any of that is disqualifying for you, it is better to know now than after you
            have moved a register across. Ask, and we will tell you exactly where we are.
          </p>
        </div>
      </section>
    </>
  );
}
