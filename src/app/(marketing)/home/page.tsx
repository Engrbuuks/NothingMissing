export const metadata = {
  title: 'Nothing Missing — asset and inventory management',
  description:
    'Know where every asset is and who moved it. Approval chains, branded waybills, field submissions from people who have no account, and an audit trail nobody can edit.',
};

const FEATURES = [
  {
    t: 'Every movement has a name on it',
    d: 'Nothing leaves a register without an approval, and nothing joins one until someone at the other end confirms it physically arrived. Between the two it belongs to neither — which is exactly what it is.',
  },
  {
    t: 'Your storekeeper does not need an account',
    d: 'Send a link over WhatsApp. They count what is in front of them and send it. Nothing they submit changes the register until a manager reviews it, so a forwarded link is worth nothing to a stranger.',
  },
  {
    t: 'Counts are blind, deliberately',
    d: 'The person counting never sees what the system expects. Show them and they will agree with it, and the count tells you nothing you did not already believe.',
  },
  {
    t: 'An audit trail nobody can edit',
    d: 'Not you, not us, not your database administrator. Every change writes a row in the same transaction, and the privileges to alter them do not exist. A mistake is corrected by writing a further event.',
  },
  {
    t: 'Costs are a separate permission',
    d: 'A location manager runs their site without ever seeing what anything cost. Not hidden in the interface — the database does not send it.',
  },
  {
    t: 'Shrinkage you can actually find',
    d: 'Fuel goes down three ways and only one is deliberate. We compare litres issued against what the engine could have burned, and tell you the gap in litres — a number someone can go and look for.',
  },
];

export default function Home() {
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-wrap">
          <span className="mkt-eyebrow">For companies with more than one site</span>
          <h1>At the end of the month, nothing is missing.</h1>
          <p className="mkt-lead">
            Asset and inventory management for depots, branches and site offices. Every
            movement approved by a named person, every delivery confirmed at the other end,
            and a record nobody can quietly tidy up.
          </p>
          <div className="mkt-actions">
            <a className="btn btn-p btn-lg" href="/sign-up" style={{ width: 'auto' }}>Start free</a>
            <a className="btn btn-g btn-lg" href="/pricing" style={{ width: 'auto' }}>See pricing</a>
          </div>
          <p className="mkt-note">No card. Set it up, put your register in, decide later.</p>
        </div>
      </section>

      <section className="mkt-band">
        <div className="mkt-wrap">
          <h2 className="mkt-h2">The problem is not that things go missing</h2>
          <p className="mkt-body">
            It is that nobody can say when. A generator was at Ibadan in March and is not
            there now, the spreadsheet was last touched in June by someone who has left, and
            the only person who knows what happened is the driver who is no longer answering
            his phone.
          </p>
          <p className="mkt-body">
            A register that anybody can edit and nobody has to justify is not a record. It is
            a note. This is built so that every change carries a name, a time and a reason —
            and so that the awkward ones cannot be deleted afterwards.
          </p>
        </div>
      </section>

      <section className="mkt-wrap" style={{ padding: '10px 24px 70px' }}>
        <div className="mkt-grid">
          {FEATURES.map((f) => (
            <div className="mkt-card" key={f.t}>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-dark">
        <div className="mkt-wrap">
          <h2>Built for how work actually happens</h2>
          <div className="mkt-steps">
            {[
              ['A transfer is raised', 'Someone at the origin picks the assets and says where they are going.'],
              ['It is approved', 'By whoever your rules say — one signature under a threshold, two above it. Nobody approves their own.'],
              ['It is dispatched', 'A gap-free waybill is issued and the assets leave the origin register. They now belong to neither end.'],
              ['It arrives', 'Someone at the destination ticks off what is physically in front of them. Anything short becomes a discrepancy with an owner and a clock.'],
            ].map(([t, d], i) => (
              <div className="mkt-step" key={t}>
                <span className="mkt-step-n">{i + 1}</span>
                <div>
                  <h4>{t}</h4>
                  <p>{d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mkt-cta-band">
        <div className="mkt-wrap">
          <h2>Put one depot on it this week</h2>
          <p>
            Import the spreadsheet you already have, send one link to one storekeeper, and
            run a single transfer end to end. That is enough to know whether it fits.
          </p>
          <a className="btn btn-p btn-lg" href="/sign-up" style={{ width: 'auto' }}>Start free</a>
        </div>
      </section>
    </>
  );
}
