import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';

export const dynamic = 'force-dynamic';

const LABEL: Record<string, string> = {
  'transfer.raised': 'A transfer is raised',
  'transfer.approved': 'A transfer is approved',
  'transfer.dispatched': 'A consignment is dispatched',
  'transfer.overdue': 'A delivery is overdue',
  'transfer.received': 'A delivery is accepted',
  'discrepancy.opened': 'A line is flagged on receipt',
  'request.raised': 'A request needs approval',
  'request.decided': 'A request is approved or rejected',
  'submission.received': 'Something arrives from a field link',
  'submission.reviewed': 'A field submission is reviewed',
  'stock.below_reorder': 'Stock falls below its reorder point',
  'maintenance.due': 'A service falls due',
  'goods.received': 'Goods are received against an order',
};

export default async function Notifications() {
  const session = await getSession();
  const supabase = sb();

  if (!hasRole(session, 'owner', 'admin')) {
    return (
      <Shell current="notifications" title="Notifications" subtitle="Who gets told what">
        <div className="card"><div className="empty"><h4>Not available to your role</h4>
        <p>Only an owner or admin can change what the company sends.</p></div></div>
      </Shell>
    );
  }

  const { data: prefs, error } = await supabase
    .from('notification_prefs')
    .select('event, email, sms, whatsapp, locked')
    .order('event');

  const { data: queued } = await supabase
    .from('notifications')
    .select('id, event, channel, recipient, subject, status, queued_at')
    .order('queued_at', { ascending: false })
    .limit(25);

  const rows = (prefs ?? []) as any[];
  const pending = (queued ?? []) as any[];

  return (
    <Shell current="notifications" title="Notifications" subtitle="Who gets told what, and on which channel">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="notice warn">
        <p>
          <b>Nothing is being sent yet.</b> Everything the system would send is written to a
          queue you can inspect below, which is deliberate: half-built notifications reaching
          real people is worse than none, and a queued row you can read beats a
          fire-and-forget call you cannot. Wiring a provider is a few lines in
          <span className="mono"> src/lib/notify.ts</span>.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Events</div>
            <div className="card-s">
              Channel is a per-event choice — field staff on location links have a phone
              number and often no work email
            </div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>No preferences set up</h4>
            <p>Run migration 0013, which seeds the events every company starts with.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When this happens</th><th>Email</th><th>WhatsApp</th><th>SMS</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.event}>
                    <td>
                      <div className="aname">{LABEL[p.event] ?? p.event}</div>
                      <div className="amake mono">{p.event}</div>
                      {p.locked && (
                        <span className="pill p-warn" style={{ marginTop: 6 }}>
                          <span className="pd" />Cannot be switched off
                        </span>
                      )}
                    </td>
                    {(['email', 'whatsapp', 'sms'] as const).map((ch) => (
                      <td key={ch}>
                        <span className={`pill ${p[ch] ? 'p-ok' : 'p-mute'}`}>
                          <span className="pd" />{p[ch] ? 'On' : 'Off'}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint" style={{ padding: '14px 20px' }}>
          Discrepancy alerts are locked on. They are the safety net on the register, and a
          company that silences them discovers its own losses months late.
        </p>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">Queue</div>
            <div className="card-s">What would have been sent, most recent first</div>
          </div>
        </div>
        {pending.length === 0 ? (
          <div className="empty">
            <h4>Nothing queued</h4>
            <p>
              Notifications appear here as events happen. Raise a transfer or review a field
              submission and you will see exactly what the system would send, and to whom.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>When</th><th>Event</th><th>Channel</th><th>To</th><th>Status</th></tr></thead>
              <tbody>
                {pending.map((n) => (
                  <tr key={n.id}>
                    <td style={{ color: 'var(--text-2)' }}>{new Date(n.queued_at).toLocaleString('en-GB')}</td>
                    <td><div className="aname">{LABEL[n.event] ?? n.event}</div>
                    <div className="amake">{n.subject ?? ''}</div></td>
                    <td><span className="pill p-mute"><span className="pd" />{n.channel}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{n.recipient}</td>
                    <td>
                      <span className={`pill ${n.status === 'sent' ? 'p-ok' : n.status === 'failed' ? 'p-bad' : 'p-warn'}`}>
                        <span className="pd" />{n.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Shell>
  );
}
