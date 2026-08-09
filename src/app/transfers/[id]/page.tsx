import Shell from '@/components/Shell';
import { sb, getSession, canAccessLocation } from '@/lib/session';
import {
  approveTransfer,
  dispatchTransfer,
  acceptTransfer,
  cancelTransfer,
} from '@/lib/actions';

export const dynamic = 'force-dynamic';

const STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'p-mute' },
  pending: { label: 'Awaiting approval', cls: 'p-warn' },
  approved: { label: 'Approved, not dispatched', cls: 'p-sky' },
  in_transit: { label: 'In transit', cls: 'p-sky' },
  received: { label: 'Received', cls: 'p-ok' },
  cancelled: { label: 'Cancelled', cls: 'p-mute' },
  rejected: { label: 'Rejected', cls: 'p-bad' },
};

export default async function TransferDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { error?: string; done?: string };
}) {
  const session = await getSession();
  const supabase = sb();

  const { data: t, error } = await supabase
    .from('transfers')
    .select(
      `id, reference, status, reason, notes, driver_name, vehicle_reg,
       waybill_no, waybill_issued_at, dispatched_at, received_at,
       from_location, to_location,
       from:from_location ( name ), to:to_location ( name )`
    )
    .eq('id', params.id)
    .maybeSingle();

  if (error || !t) {
    return (
      <Shell current="transfers" title="Transfer" subtitle="Not found">
        <div className="notice bad">
          <p>
            {error?.message ??
              'No transfer with that reference is visible to you. It may belong to locations outside your scope.'}
          </p>
        </div>
      </Shell>
    );
  }

  const tr = t as any;
  const st = STATE[tr.status] ?? STATE.draft;

  const { data: lines } = await supabase
    .from('transfer_lines')
    .select('id, asset_id, received, flagged, flag_note, assets ( tag, name, serial_no )')
    .eq('transfer_id', params.id);

  const rows = (lines ?? []) as any[];
  const undecided = rows.filter((l) => l.received === null);

  // Only someone whose membership covers the destination may accept. This
  // hides the button; app.accept_transfer() enforces it regardless.
  const canReceive =
    tr.status === 'in_transit' &&
    undecided.length > 0 &&
    canAccessLocation(session, tr.to_location);

  const { data: discrepancies } = await supabase
    .from('discrepancies')
    .select('id, reference, kind, note, resolved_at')
    .eq('transfer_id', params.id);

  const open = (discrepancies ?? []).filter((d: any) => !d.resolved_at);

  return (
    <Shell
      current="transfers"
      title={tr.waybill_no ?? tr.reference}
      subtitle={`${tr.from?.name ?? '—'} → ${tr.to?.name ?? '—'}`}
    >
      <a className="btn btn-g" href="/transfers" style={{ marginBottom: 18 }}>
        Back to transfers
      </a>

      {searchParams.error && (
        <div className="notice bad">
          <p>{searchParams.error}</p>
        </div>
      )}
      {searchParams.done && (
        <div className="notice">
          <p>
            Done. Everything accepted moved to {tr.to?.name} in one transaction, and the
            audit log has a row naming you.
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{tr.waybill_no ?? tr.reference}</div>
            <div className="card-s">{tr.reason ?? 'No reason given'}</div>
          </div>
          <span className={`pill ${st.cls}`} style={{ marginLeft: 'auto' }}>
            <span className="pd" />
            {st.label}
          </span>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>From</td>
                <td>{tr.from?.name ?? '—'}</td>
                <td style={{ color: 'var(--text-3)' }}>To</td>
                <td>{tr.to?.name ?? '—'}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Driver</td>
                <td>{tr.driver_name ?? '—'}</td>
                <td style={{ color: 'var(--text-3)' }}>Vehicle</td>
                <td className="mono">{tr.vehicle_reg ?? '—'}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Waybill issued</td>
                <td>
                  {tr.waybill_issued_at
                    ? new Date(tr.waybill_issued_at).toLocaleString('en-GB')
                    : 'Not yet — issued at dispatch'}
                </td>
                <td style={{ color: 'var(--text-3)' }}>Received</td>
                <td>
                  {tr.received_at ? new Date(tr.received_at).toLocaleString('en-GB') : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {open.length > 0 && (
        <div className="notice warn">
          <p>
            <b>
              {open.length} open discrepanc{open.length === 1 ? 'y' : 'ies'}.
            </b>{' '}
            Those assets are still in transit and belong to neither register. The waybill
            stays open until each one is resolved.
          </p>
        </div>
      )}

      {/* Receiving. The manifest is a checklist, and the button says exactly
          what it is about to do. */}
      {canReceive ? (
        <form action={acceptTransfer}>
          <input type="hidden" name="id" value={tr.id} />
          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Manifest · {undecided.length} to confirm</div>
                <div className="card-s">
                  Check each item physically. Tick anything short or damaged — the rest
                  still moves.
                </div>
              </div>
            </div>
            {undecided.map((l) => (
              <div
                key={l.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '14px 20px',
                  borderBottom: '1px solid var(--line-2)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="aname">{l.assets?.name}</div>
                  <div className="amake">
                    <span className="tag">{l.assets?.tag}</span>
                    {l.assets?.serial_no ? ` · ${l.assets.serial_no}` : ''}
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <input type="checkbox" name="flag" value={l.asset_id} />
                  Not received
                </label>
              </div>
            ))}
            <div style={{ padding: 20 }}>
              <label className="lbl" htmlFor="notes">
                Note for the record
              </label>
              <input
                className="inp"
                id="notes"
                name="notes"
                placeholder="Anything worth recording about this delivery"
              />
              <div className="hint">
                Accepting writes every movement, the waybill receipt and the audit rows in one
                transaction. If it fails, nothing moves.
              </div>
              <div style={{ height: 16 }} />
              <button className="btn btn-p" type="submit">
                Accept the delivery
              </button>
            </div>
          </div>
        </form>
      ) : (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">
                Manifest · {rows.length} asset{rows.length === 1 ? '' : 's'}
              </div>
              <div className="card-s">
                {tr.status === 'in_transit' && !canAccessLocation(session, tr.to_location)
                  ? `Only someone who can act at ${tr.to?.name} may confirm this delivery`
                  : 'What this consignment carries'}
              </div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Asset</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className="tag">{l.assets?.tag}</span>
                    </td>
                    <td>
                      <div className="aname">{l.assets?.name}</div>
                    </td>
                    <td>
                      {l.received === null ? (
                        <span className="pill p-mute">
                          <span className="pd" />
                          Not yet decided
                        </span>
                      ) : l.flagged ? (
                        <span className="pill p-warn">
                          <span className="pd" />
                          Flagged
                        </span>
                      ) : (
                        <span className="pill p-ok">
                          <span className="pd" />
                          Received
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The steps before dispatch. Each is a separate deliberate act. */}
      <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        {tr.status === 'draft' && (
          <>
            <form action={approveTransfer.bind(null, tr.id)}>
              <button className="btn btn-p" type="submit">
                Approve
              </button>
            </form>
            <form action={cancelTransfer.bind(null, tr.id)}>
              <button className="btn btn-g" type="submit">
                Cancel
              </button>
            </form>
          </>
        )}
        {tr.status === 'approved' && (
          <form action={dispatchTransfer.bind(null, tr.id)}>
            <button className="btn btn-p" type="submit">
              Dispatch and issue the waybill
            </button>
          </form>
        )}
      </div>

      {tr.status === 'approved' && (
        <p className="hint" style={{ marginTop: 12, maxWidth: 620 }}>
          Dispatching issues a gap-free waybill number and takes every asset off the origin
          register. It re-checks that each one is still where the transfer says it is — if
          something moved since approval, it refuses rather than dispatching a line that
          describes a world that no longer exists.
        </p>
      )}
    </Shell>
  );
}
