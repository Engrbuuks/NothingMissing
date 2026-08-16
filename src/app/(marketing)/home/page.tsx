import { Illustration } from '@/components/Illustration';
import { Icon } from '@/components/icons';

export const metadata = {
  title: 'Nothing Missing — asset and inventory management',
  description:
    'Know where every asset is and who moved it. Approval chains, branded waybills, field submissions from people who have no account, and an audit trail nobody can edit.',
};

const CAPABILITIES = [
  [Icon.route, 'Approved movement',
   'Nothing leaves a register without an approval, and nothing joins one until someone at the other end confirms it physically arrived. Between the two it belongs to neither — which is exactly what it is.'],
  [Icon.phone, 'Field links, not licences',
   'Your storekeeper counts what is in front of him and sends it from a WhatsApp link. No account, no seat, no reason to leave the register stale.'],
  [Icon.clipboard, 'Blind counting',
   'The person counting never sees what the system expects. Show them and they will agree with it, and the count tells you nothing you did not already believe.'],
  [Icon.lock, 'An audit trail nobody can edit',
   'Not you, not us, not your database administrator. Every change writes a row in the same transaction, and the permission to alter one does not exist.'],
  [Icon.fuel, 'Shrinkage you can find',
   'Fuel goes down three ways and only one is deliberate. We compare litres issued against what the engine could have burned, and give you the gap in litres.'],
  [Icon.chart, 'Costs behind a permission',
   'A location manager runs their site without ever seeing what anything cost. Not hidden in the interface — the database does not send it.'],
];

const INDUSTRIES = [
  [Icon.drill, 'Drilling and construction',
   'Rigs, compressors and generators that move between sites weekly, and the fuel that goes with them.'],
  [Icon.factory, 'Manufacturing',
   'Spares, tooling and safety stock across a plant, with counts that reconcile rather than argue.'],
  [Icon.building, 'Multi-branch services',
   'Laptops, printers and furniture that follow staff between offices and quietly stop being findable.'],
  [Icon.truck, 'Logistics and haulage',
   'Vehicles, trailers and equipment on the road, with a waybill a driver can actually hand over.'],
  [Icon.boxes, 'Facilities management',
   'Client sites you are accountable for, where "we think it is at Ibadan" is not an acceptable answer.'],
  [Icon.shield, 'Anyone with an auditor',
   'A register that explains itself, because the questions come once a year and always about last March.'],
];

const FAQS = [
  ['Do my site staff need accounts?',
   'No, and that is deliberate. They get a link over WhatsApp that works on any phone. Charging per seat pushes companies towards fewer people recording things, which is how registers go stale in the first place.'],
  ['What happens if someone disputes a delivery?',
   'The waybill is frozen at the moment it was issued, the person who accepted it is named, and anything short became a discrepancy with an owner and a clock on it. All of that is in a log nobody can edit.'],
  ['Can I import what I already have?',
   'Yes. Paste your spreadsheet and it imports as one batch — so a duplicate serial rejects the whole thing rather than half-importing a register you can no longer trust.'],
  ['Can I use my own colours and logo?',
   'Yes. Your waybills carry your identity, not ours. One brand colour, and everything else derives from it.'],
  ['Is my data separate from other companies?',
   'Separated by the database itself, not by our code. A query that forgot to filter returns nothing rather than somebody else\u2019s register. There is a test that proves it on every change.'],
  ['What does it cost?',
   'Free under 50 assets. Beyond that it is priced per asset with no charge per person. The pricing page says plainly which parts of that number we are still unsure about.'],
];

export default function Home() {
  return (
    <>
      {/* ---------- hero ---------- */}
      <section className="hro">
        <div className="mkt-wrap">
          <div className="hro-grid">
            <div>
              <span className="sec-eyebrow">For companies with more than one site</span>
              <h1>At the end of the month, nothing is missing.</h1>
              <p>
                Asset and inventory management for depots, branches and site offices. Every
                movement approved by a named person, every delivery confirmed at the other
                end, and a record nobody can quietly tidy up.
              </p>
              <div className="hro-cta">
                <a className="btn btn-p btn-lg" href="/sign-up" style={{ width: 'auto' }}>Start free</a>
                <a className="btn btn-g btn-lg" href="/pricing" style={{ width: 'auto' }}>See pricing</a>
              </div>
              <p className="mkt-note">No card. Free under 50 assets, for as long as you like.</p>
            </div>

            <Illustration
              name="hero-depot-network"
              alt="A depot, a branch office and a site yard connected by a delivery route, with assets tracked between them"
              width={1200}
              height={900}
              priority
            />
          </div>

          {/* ---------- stats ---------- */}
          <div className="stats">
            <div className="stats-h">
              <div>
                <h3>What the register actually gives you</h3>
                <p>
                  Numbers that come from your own movements rather than a brochure — these
                  are what the system computes for a company using it properly.
                </p>
              </div>
              <a className="btn btn-p" href="/sign-up">Get started</a>
            </div>
            <div className="stats-row">
              {[
                ['100%', 'Movements with a name on them'],
                ['0', 'Audit rows anyone can edit'],
                ['3', 'Ways fuel goes down, all accounted'],
                ['1 link', 'What a storekeeper needs'],
              ].map(([v, l]) => (
                <div className="stat" key={l}><b>{v}</b><span>{l}</span></div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- the problem ---------- */}
      <section className="sec tint">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">The problem</span>
          <h2>It is not that things go missing. It is that nobody can say when.</h2>
          <div className="split">
            <div>
              <p className="sec-sub">
                A generator was at Ibadan in March and is not there now. The spreadsheet was
                last touched in June by someone who has left. The only person who knows what
                happened is the driver who is no longer answering his phone.
              </p>
              <p className="sec-sub">
                A register anybody can edit and nobody has to justify is not a record. It is a
                note. This is built so every change carries a name, a time and a reason — and
                so the awkward ones cannot be deleted afterwards.
              </p>
              <div className="pills">
                {['Named approvals', 'Frozen waybills', 'Blind counts', 'Immutable log'].map((t) => (
                  <span className="tpill" key={t}><i />{t}</span>
                ))}
              </div>
            </div>
            <Illustration
              name="problem-stale-register"
              alt="A warehouse worker holding a clipboard that does not match what is on the shelves"
              width={900}
              height={760}
            />
          </div>
        </div>
      </section>

      {/* ---------- capabilities ---------- */}
      <section className="sec">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">What it does</span>
          <h2>Built around how the work actually happens</h2>
          <p className="sec-sub">
            Not a database with forms on top. Every decision here came from watching what
            goes wrong between one site and another.
          </p>
          <div className="fgrid">
            {CAPABILITIES.map(([I, title, body]) => {
              const Ico = I as () => JSX.Element;
              return (
                <div className="feat" key={title as string}>
                  <span className="feat-ic"><Ico /></span>
                  <div>
                    <h3>{title as string}</h3>
                    <p>{body as string}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------- how a transfer works ---------- */}
      <section className="sec tint">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">A movement, end to end</span>
          <h2>Four steps, and a name against each one</h2>
          <div className="split">
            <Illustration
              name="transfer-four-steps"
              alt="A consignment being raised, approved, dispatched with a waybill, and received at a depot"
              width={900}
              height={800}
            />
            <div>
              <div className="mkt-steps" style={{ gap: 22 }}>
                {[
                  ['Raised', 'Someone at the origin picks the assets and says where they are going.'],
                  ['Approved', 'By whoever your rules say — one signature under a threshold, two above it. Nobody approves their own.'],
                  ['Dispatched', 'A gap-free waybill is issued and the assets leave the origin register. They now belong to neither end.'],
                  ['Received', 'Someone at the destination ticks off what is physically in front of them. Anything short becomes a discrepancy with an owner and a clock.'],
                ].map(([t, d], i) => (
                  <div className="mkt-step" key={t} style={{ alignItems: 'flex-start' }}>
                    <span className="mkt-step-n" style={{ background: 'var(--brand)' }}>{i + 1}</span>
                    <div>
                      <h4 style={{ color: 'var(--text)' }}>{t}</h4>
                      <p style={{ color: 'var(--text-2)' }}>{d}</p>
                    </div>
                  </div>
                ))}
              </div>
              <div className="ovcard" style={{ marginTop: 26 }}>
                <h4>The waybill is frozen at issue</h4>
                <p>
                  A driver carries it through checkpoints, so the copy in his hand keeps
                  matching the copy in the system. Renaming a location next month does not
                  rewrite a document issued today.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- field links ---------- */}
      <section className="sec">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">The part nobody else has</span>
          <h2>Your storekeeper does not need an account</h2>
          <div className="split">
            <div>
              <p className="sec-sub">
                He is the only person who knows what is actually in the yard. Asking a company
                to buy him a seat is how registers go stale — so he gets a link instead, over
                WhatsApp, that works on any phone.
              </p>
              <p className="sec-sub">
                Nothing he submits changes the register. It waits for a manager, who sees the
                count beside the system figure and decides. A forwarded link is worth nothing
                to a stranger: it cannot read the register, see costs, or reach another site.
              </p>
              <div className="pills">
                {['No login', 'Works on any phone', 'Expires and revokes', 'Every count named'].map((t) => (
                  <span className="tpill" key={t}><i />{t}</span>
                ))}
              </div>
            </div>
            <Illustration
              name="field-link-phone"
              alt="A storekeeper in a yard entering a stock count on a phone from a link"
              width={900}
              height={780}
            />
          </div>
        </div>
      </section>

      {/* ---------- industries ---------- */}
      <section className="sec tint">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">Who it is for</span>
          <h2>Companies whose things move</h2>
          <p className="sec-sub">
            If everything lives in one building and never leaves, a spreadsheet is fine. This
            is for the other case.
          </p>
          <div className="fgrid">
            {INDUSTRIES.map(([I, title, body]) => {
              const Ico = I as () => JSX.Element;
              return (
                <div className="feat" key={title as string}>
                  <span className="feat-ic" style={{ background: 'var(--amber-soft)', color: '#B87309' }}><Ico /></span>
                  <div>
                    <h3>{title as string}</h3>
                    <p>{body as string}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="sec">
        <div className="mkt-wrap">
          <span className="sec-eyebrow">Before you ask</span>
          <h2>Frequently asked questions</h2>
          <div className="faq">
            {FAQS.map(([q, a], i) => (
              <details key={q} open={i === 0}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- closing ---------- */}
      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="mkt-wrap">
          <div className="close-band">
            <div>
              <h2>Put one depot on it this week</h2>
              <p>
                Import the spreadsheet you already have, send one link to one storekeeper, and
                run a single transfer end to end. That is enough to know whether it fits.
              </p>
              <div className="hro-cta">
                <a className="btn btn-p btn-lg" href="/sign-up" style={{ width: 'auto' }}>Start free</a>
                <a className="btn btn-g btn-lg" href="/security" style={{ width: 'auto' }}>How we keep it separate</a>
              </div>
            </div>
            <Illustration
              name="closing-team-handover"
              alt="A site team and an office manager confirming a delivery together"
              width={860}
              height={620}
            />
          </div>
        </div>
      </section>
    </>
  );
}
