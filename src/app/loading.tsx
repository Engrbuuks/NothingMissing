/**
 * Shown while a page's data loads. With a real database and a few thousand
 * assets, the register will not paint instantly, and a blank screen reads as
 * broken rather than busy.
 */
export default function Loading() {
  return (
    <main style={{ padding: '28px 28px 56px' }}>
      <div
        style={{
          height: 14, width: 180, borderRadius: 7,
          background: 'var(--line-2)', marginBottom: 22,
        }}
      />
      <div className="card">
        <div style={{ padding: 20 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              style={{
                height: 44,
                borderRadius: 10,
                background: 'var(--line-2)',
                marginBottom: 10,
                opacity: 1 - i * 0.13,
              }}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
