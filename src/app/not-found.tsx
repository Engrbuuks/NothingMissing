export default function NotFound() {
  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px' }}>
      <h1 style={{ fontSize: 24 }}>That page does not exist</h1>
      <p style={{ color: 'var(--text-2)', marginTop: 14, lineHeight: 1.65 }}>
        It may have been a link to something that has since been disposed of or archived —
        those stay in the audit log but leave the live register.
      </p>
      <a className="btn btn-p" href="/assets" style={{ marginTop: 24 }}>
        Back to the register
      </a>
    </main>
  );
}
