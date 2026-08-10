import Shell from '@/components/Shell';
import { sb } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The audit log.
 *
 * Readable by everyone in the company, which is the point: a trail only deters
 * anything if the people it describes know it is visible. Nobody can edit or
 * delete a row — not an owner, not the application, not the table owner.
 */
export default async function Audit({
  searchParams,
}: { searchParams: { q?: string; entity?: string; tone?: string; actor?: string } }) {
  const supabase = sb();
  const q = (searchParams.q ?? '').trim();
  const entity = searchParams.entity ?? 'all';
  const tone = searchParams.tone ?? 'all';

  let query = supabase
    .from('audit_events')
    .select('id, occurred_at, actor_label, actor_kind, action, entity, entity_id, reference, detail, tone, locations ( name )')
    .order('occurred_at', { ascending: false })
    .limit(300);

  if (entity !== 'all') query = query.eq('entity', entity);
  if (tone !== 'all') query = query.eq('tone', tone);
  if (q) query = query.or(`action.ilike.%${q}%,detail.ilike.%${q}%,reference.ilike.%${q}%,actor_label.ilike.%${q}%`);

  const { data, error } = await query;
  const rows = (data ?? []) as any[];

  const { data: allEntities } = await supabase.from('audit_events').select('entity').limit(1000);
  const entities = [...new Set((allEntities ?? []).map((e: any) => e.entity))].sort();
  const filtered = q !== '' || entity !== 'all' || tone !== 'all';

  const exportQS = new URLSearchParams();
  if (q) exportQS.set('q', q);
  if (entity !== 'all') exportQS.set('entity', entity);
  if (tone !== 'all') exportQS.set('tone', tone);

  return (
    <Shell current="audit" title="Audit log" subtitle="Every change, with a name against it">
      <div className="notice">
        <p>
          <b>This log is append-only at the database.</b> There is no update or delete policy,
          the privileges are revoked, and a trigger refuses regardless — so even the table
          owner cannot quietly tidy the record. A mistake is corrected by writing a further
          event, never by editing history.
        </p>
      </div>

      <form className="toolbar" method="get" action="/audit">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input name="q" defaultValue={q} placeholder="Search action, reference, detail or person" />
        </div>
        <select className="sel" name="entity" defaultValue={entity}>
          <option value="all">Everything</option>
          {entities.map((e: any) => <option key={e} value={e}>{e}</option>)}
        </select>
        <select className="sel" name="tone" defaultValue={tone}>
          <option value="all">Any severity</option>
          <option value="ok">Completed</option>
          <option value="info">Routine</option>
          <option value="warn">Needs attention</option>
          <option value="bad">Serious</option>
        </select>
        <button className="btn btn-g" type="submit">Apply</button>
        {filtered && <a className="btn btn-g" href="/audit">Clear</a>}
        <a className="btn btn-g" href={`/audit/export?${exportQS.toString()}`} style={{ marginLeft: 'auto' }}>Export</a>
      </form>

      <div className="card">
        <div className="card-h bd">
          <div>
            <div className="card-t">{rows.length} event{rows.length === 1 ? '' : 's'}</div>
            <div className="card-s">
              {filtered ? 'Matching your filters' : 'Most recent first, capped at 300'}
            </div>
          </div>
        </div>
        {error && <div className="notice bad" style={{ margin: 16 }}><p>{error.message}</p></div>}
        {rows.length === 0 ? (
          <div className="empty">
            <h4>{filtered ? 'Nothing matches those filters' : 'Nothing recorded yet'}</h4>
            <p>
              {filtered
                ? 'Clear the search or widen the filters.'
                : 'Every movement, approval and adjustment writes here as it happens.'}
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>What</th><th>Detail</th><th>Reference</th><th>Where</th></tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td style={{ color: 'var(--text-2)', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                      {new Date(e.occurred_at).toLocaleString('en-GB')}
                    </td>
                    <td>
                      <div className="aname">{e.actor_label}</div>
                      {e.actor_kind !== 'user' && (
                        <div className="amake">
                          {e.actor_kind === 'link' ? 'via a location link — no account' : 'system'}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`pill ${e.tone === 'ok' ? 'p-ok' : e.tone === 'warn' ? 'p-warn' : e.tone === 'bad' ? 'p-bad' : 'p-mute'}`}>
                        <span className="pd" />{e.action}
                      </span>
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--text-2)', maxWidth: 380 }}>{e.detail ?? '—'}</td>
                    <td>{e.reference ? <span className="tag">{e.reference}</span> : '—'}</td>
                    <td style={{ color: 'var(--text-2)' }}>{e.locations?.name ?? '—'}</td>
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
