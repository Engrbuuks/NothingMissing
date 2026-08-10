export const metadata = { title: 'About — Nothing Missing' };

export default function About() {
  return (
    <>
      <section className="mkt-hero" style={{ paddingBottom: 40 }}>
        <div className="mkt-wrap">
          <span className="mkt-eyebrow">About</span>
          <h1 style={{ fontSize: 38 }}>Built in Lagos, for companies that move things.</h1>
          <p className="mkt-lead">
            Drilling rigs across three states. Generators at every branch. Laptops that follow
            staff between offices. The spreadsheet works until it does not, and it stops
            working quietly.
          </p>
        </div>
      </section>

      <section className="mkt-band">
        <div className="mkt-wrap">
          <h2 className="mkt-h2">What we decided early</h2>
          <p className="mkt-body">
            <b>The people who touch the assets are not the people with logins.</b> A
            storekeeper in Ibadan is the only person who knows what is actually in the yard,
            and asking a company to buy him a seat is how registers go stale. He gets a link.
          </p>
          <p className="mkt-body">
            <b>A record you can edit is not a record.</b> Every system we looked at let an
            administrator quietly change history. Ours cannot, and that constraint costs us
            features we would otherwise have shipped.
          </p>
          <p className="mkt-body">
            <b>Refusing is sometimes the feature.</b> The system will not let you receive three
            machines with two serial numbers, or write off a theft without a police reference.
            Those refusals are annoying exactly once, and then they are the reason the register
            still means something a year later.
          </p>
        </div>
      </section>

      <section className="mkt-cta-band">
        <div className="mkt-wrap">
          <h2>Try it on one site</h2>
          <p>That is enough to tell whether it fits how you actually work.</p>
          <a className="btn btn-p btn-lg" href="/sign-up" style={{ width: 'auto' }}>Start free</a>
        </div>
      </section>
    </>
  );
}
