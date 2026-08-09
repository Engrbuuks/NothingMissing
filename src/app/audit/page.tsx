import Shell from '@/components/Shell';
import { sb } from '@/lib/session';

export const dynamic = 'force-dynamic';

const TONE: Record<string, string> = { ok: 'p-ok', warn: 'p-warn', bad: 'p-bad', info: 'p-sky' };

/**
 * The audit log. Readable by everyone in the company on purpose — a trail only
 * deters anything if the people it describes know it is visible. Nobody can
 * edit or delete it, including owners: there is no UPDATE or DELETE policy,
 * the privileges are revoked, and a trigger raises regardless.
 */
export default async function Audit() {
  const supabase = sb();

  const { data, error } = await supabase
    .from('audit_events')
    .select('id, occurred_at, actor_label, actor_kind, action, reference, detail, tone')
    .order('occurred_at', { ascending: false })
    .limit(200);

  const rows = data ?? [];

  return (
    <Shell current="audit" title="Audit log" subtitle="Append-only. Nothing here can be edited or deleted.">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="notice">
        <p>
          Every row here was written by a database trigger inside the same transaction as
          the change it describes. If the change rolled back, so did its row. Application
          code cannot forget to log something, because application code is not what logs it.
        </p>
      </div>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} event{rows.length === 1 ? '' : 's'}</div>
            <div className="card-s">Newest first · retained for the life of the account</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">
            <h4>Nothing recorded yet</h4>
            <p>Move an asset, adjust stock or change a setting and it will appear here.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>Action</th><th>Reference</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {rows.map((e: any) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ whiteSpace: 'nowrap', color: 'var(--text-2)', fontSize: 12 }}>
                      {new Date(e.occurred_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td>
                      {e.actor_label}
                      {e.actor_kind === 'link' && <span className="pill p-mute" style={{ marginLeft: 6 }}>via link</span>}
                      {e.actor_kind === 'system' && <span className="pill p-mute" style={{ marginLeft: 6 }}>system</span>}
                    </td>
                    <td><span className={`pill ${TONE[e.tone] ?? 'p-sky'}`}><span className="pd" />{e.action}</span></td>
                    <td><span className="tag">{e.reference ?? '—'}</span></td>
                    <td style={{ color: 'var(--text-2)' }}>{e.detail ?? '—'}</td>
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
