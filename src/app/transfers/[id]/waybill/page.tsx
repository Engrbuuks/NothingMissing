import { sb, logoUrl } from '@/lib/session';
import { Mark } from '@/components/Mark';

export const dynamic = 'force-dynamic';

/**
 * The printable waybill.
 *
 * Rendered from the frozen snapshot, not from live data. A driver carries this
 * through checkpoints, and the copy in his hand has to keep matching the copy
 * in the system — renaming a location next month must not silently rewrite a
 * document issued today.
 *
 * Printed rather than generated as a PDF server-side: the browser's own print
 * dialogue produces a real PDF, respects the user's paper size, and needs no
 * headless Chrome running on a server. One less thing to break at 2am.
 */
export default async function Waybill({ params }: { params: { id: string } }) {
  const supabase = sb();

  const { data: doc } = await supabase
    .from('waybill_documents')
    .select('waybill_no, revision, snapshot, issued_at, issued_label')
    .eq('transfer_id', params.id)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!doc) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '70px 24px' }}>
        <h1 style={{ fontSize: 22 }}>No waybill has been issued</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          A waybill is issued at dispatch, when the assets actually leave the origin
          register. Until then there is nothing to print.
        </p>
        <a className="btn btn-g" href={`/transfers/${params.id}`} style={{ marginTop: 20 }}>
          Back to the consignment
        </a>
      </main>
    );
  }

  const s = (doc as any).snapshot;
  const brand = s.company?.brand_hex ?? '#0551BD';
  const companyLogo = logoUrl(s.company?.logo_path);
  const lines: any[] = s.lines ?? [];

  return (
    <>
      <div className="wb-bar">
        <a className="btn btn-g" href={`/transfers/${params.id}`}>Back</a>
        <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          Use your browser&rsquo;s print dialogue and choose &ldquo;Save as PDF&rdquo;
        </span>
        <a className="btn btn-p" href="?print=1" style={{ marginLeft: 'auto' }}>Print</a>
      </div>

      <article className="wb" style={{ ['--wb' as string]: brand } as React.CSSProperties}>
        <header className="wb-head">
          <div>
            {/* The customer's logo if they have one. A waybill goes to a
                checkpoint and a third-party depot, so it should carry their
                identity, not ours. */}
            {companyLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={companyLogo} alt="" className="wb-logo" />
            )}
            <div className="wb-co">{s.company?.name}</div>
            {s.company?.registration_no && <div className="wb-rc">{s.company.registration_no}</div>}
            {s.company?.address && <div className="wb-addr">{s.company.address}</div>}
            {s.company?.phone && <div className="wb-addr">{s.company.phone}</div>}
          </div>
          <div className="wb-no">
            <div className="wb-no-l">Waybill</div>
            <div className="wb-no-v">{(doc as any).waybill_no}</div>
            {(doc as any).revision > 1 && (
              <div className="wb-rev">Revision {(doc as any).revision}</div>
            )}
            <div className="wb-date">
              {new Date((doc as any).issued_at).toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric',
              })}
            </div>
          </div>
        </header>

        <section className="wb-route">
          <div>
            <div className="wb-lbl">From</div>
            <div className="wb-place">{s.route?.from?.name ?? '—'}</div>
            <div className="wb-sub">{s.route?.from?.address ?? s.route?.from?.city ?? ''}</div>
          </div>
          <div className="wb-arrow">→</div>
          <div>
            <div className="wb-lbl">To</div>
            <div className="wb-place">{s.route?.to?.name ?? '—'}</div>
            <div className="wb-sub">{s.route?.to?.address ?? s.route?.to?.city ?? ''}</div>
          </div>
        </section>

        <section className="wb-meta">
          <div><span className="wb-lbl">Driver</span><b>{s.waybill?.driver ?? '—'}</b></div>
          <div><span className="wb-lbl">Vehicle</span><b className="mono">{s.waybill?.vehicle ?? '—'}</b></div>
          <div><span className="wb-lbl">Reason</span><b>{s.waybill?.reason ?? '—'}</b></div>
          <div><span className="wb-lbl">Items</span><b>{lines.length}</b></div>
        </section>

        <table className="wb-tbl">
          <thead>
            <tr><th style={{ width: 34 }}>#</th><th>Tag</th><th>Description</th><th>Serial</th><th style={{ width: 90 }}>Received</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.tag}>
                <td className="mono">{i + 1}</td>
                <td className="mono"><b>{l.tag}</b></td>
                <td>{[l.brand, l.model].filter(Boolean).join(' ') || l.name}</td>
                <td className="mono">{l.serial ?? '—'}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>

        <section className="wb-sign">
          {['Released by', 'Carried by', 'Received by'].map((r) => (
            <div key={r}>
              <div className="wb-sig-line" />
              <div className="wb-lbl">{r}</div>
              <div className="wb-sig-sub">Name, signature and date</div>
            </div>
          ))}
        </section>

        <footer className="wb-foot">
          <p>
            This waybill was issued on{' '}
            {new Date((doc as any).issued_at).toLocaleString('en-GB')} by{' '}
            {(doc as any).issued_label}, and is a frozen copy — the details above are as they
            stood at issue and do not change afterwards. Any correction is issued as a new
            revision with a new number; this one stays in the archive.
          </p>
          <p className="wb-brand" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Mark size={13} /> Nothing Missing · nothingmissing.ng
          </p>
        </footer>
      </article>
    </>
  );
}
