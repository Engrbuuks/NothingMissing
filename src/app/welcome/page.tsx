export default function Welcome() {
  return (
    <main className="wrap" style={{ paddingTop: 80, paddingBottom: 80, maxWidth: 640 }}>
      <h1 style={{ fontSize: 30 }}>Nothing Missing</h1>
      <p style={{ color: 'var(--text-2)', marginTop: 14, fontSize: 15.5, lineHeight: 1.65 }}>
        Asset and inventory management for companies running depots, branches and site
        offices. Every movement approved by a named person, every delivery confirmed at the
        other end, and an audit trail nobody can edit — including you.
      </p>
      <div className="notice" style={{ marginTop: 28 }}>
        <p>
          Each company signs in at its own address, like{' '}
          <span className="mono">zenith.nothingmissing.ng</span>. If you have one, go there
          directly. If you do not, ask whoever set up your company for the link.
        </p>
      </div>
      <a className="btn btn-p" href="/sign-in" style={{ marginTop: 8 }}>
        Sign in
      </a>
    </main>
  );
}
