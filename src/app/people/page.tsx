import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { issueLink, revokeLink, setMemberRole } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const VERBS: [string, string][] = [
  ['count', 'Submit stock counts'],
  ['fault', 'Flag faults and damage'],
  ['transfer_request', 'Request transfers'],
  ['confirm_delivery', 'Confirm deliveries'],
  ['meter_reading', 'Record meter readings'],
];

export default async function People({
  searchParams,
}: { searchParams: { token?: string; slug?: string; error?: string; role?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const isAdmin = hasRole(session, 'owner', 'admin');

  const { data: members } = await supabase
    .from('memberships')
    .select('id, user_id, role, location_id, profiles ( full_name, email ), locations ( name )');

  // link_health answers the question a manager actually has — is this link
  // working, how much of its monthly allowance is gone, and has anyone touched
  // it lately. A link nobody has used in six weeks is either a person who has
  // left or a process that quietly stopped.
  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const { data: health } = co
    ? await supabase.rpc('link_health', { p_company: (co as any).id })
    : { data: [] as any[] };
  const links = health;

  const { data: locations } = await supabase
    .from('locations').select('id, name').is('archived_at', null).order('name');

  // What each role can do, read from the database rather than written here, so
  // the description and the behaviour cannot drift apart.
  const { data: caps } = await supabase.rpc('role_capabilities');
  const owners = ((members ?? []) as any[]).filter((m) => m.role === 'owner').length;

  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';

  return (
    <Shell current="people" title="People" subtitle="Accounts, and the people who hold a link instead">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.role && <div className="notice"><p>Role updated.</p></div>}

      {owners === 1 && isAdmin && (
        <div className="notice warn">
          <p>
            <b>This company has one owner.</b> If that person leaves or loses access, nobody
            can administer it — only an owner can make another owner. Promote a second one
            below while you can.
          </p>
        </div>
      )}

      <details className="explain" style={{ marginBottom: 18 }}>
        <summary>What can each role do?</summary>
        <div className="explain-body">
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>Role</th><th>Sees</th><th>Can</th><th>Cannot</th></tr></thead>
              <tbody>
                {((caps ?? []) as any[]).map((c) => (
                  <tr key={c.role}>
                    <td><b style={{ textTransform: 'capitalize' }}>{c.role}</b></td>
                    <td style={{ color: 'var(--text-2)' }}>{c.scope}</td>
                    <td>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                        {(c.can_do ?? []).map((x: string) => <li key={x}>{x}</li>)}
                      </ul>
                    </td>
                    <td>
                      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.6 }}>
                        {(c.cannot_do ?? []).map((x: string) => <li key={x}>{x}</li>)}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {searchParams.token && (
        <div className="notice">
          <p>
            <b>Send this link now — it cannot be shown again.</b> Only its hash is stored, for
            the same reason you cannot be shown your own password.
            <br /><br />
            <span className="mono" style={{ background: 'rgba(0,0,0,.06)', padding: '8px 12px', borderRadius: 8, display: 'inline-block', wordBreak: 'break-all' }}>
              https://{root}{searchParams.token}
            </span>
          </p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">People with accounts</div>
            <div className="card-s">A role attaches to a person and a location, not just a person</div>
          </div>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>Person</th><th>Role</th><th>Scope</th>{isAdmin && <th />}</tr></thead>
            <tbody>
              {(members ?? []).map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <div className="aname">{m.profiles?.full_name ?? m.profiles?.email ?? '—'}</div>
                    <div className="amake">{m.profiles?.email}</div>
                  </td>
                  <td><span className="pill p-mute">{m.role}</span></td>
                  <td style={{ color: 'var(--text-2)' }}>
                    {m.location_id ? m.locations?.name : 'All locations'}
                  </td>
                  {isAdmin && (
                    <td style={{ textAlign: 'right' }}>
                      {/* The select posts on change of the button beside it, so
                          a mis-click does not silently change somebody's role. */}
                      <form action={setMemberRole} style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <input type="hidden" name="user" value={m.user_id} />
                        <select className="inp" name="role" defaultValue={m.role}
                                style={{ width: 130, padding: '6px 9px', fontSize: 12.5 }}>
                          <option value="owner">Owner</option>
                          <option value="admin">Admin</option>
                          <option value="manager">Manager</option>
                          <option value="requester">Requester</option>
                          <option value="auditor">Auditor</option>
                        </select>
                        <select className="inp" name="location" defaultValue={m.location_id ?? ''}
                                style={{ width: 120, padding: '6px 9px', fontSize: 12.5 }}>
                          <option value="">All locations</option>
                          {(locations ?? []).map((l: any) => (
                            <option key={l.id} value={l.id}>{l.name}</option>
                          ))}
                        </select>
                        <button className="btn btn-g" type="submit"
                                style={{ padding: '6px 11px', fontSize: 12.5 }}>Set</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Location links · {(links ?? []).length} live</div>
            <div className="card-s">
              One location, one person, a narrow set of verbs. No account, no seat, no cost.
            </div>
          </div>
        </div>
        {(links ?? []).length === 0 ? (
          <div className="empty">
            <h4>No links issued</h4>
            <p>
              A storekeeper who counts drums twice a month will never remember a password,
              and you will never pay a seat for them. So the count never gets entered and
              the register drifts. A link is a URL in a WhatsApp message instead.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Holder</th><th>Location</th><th>Can do</th>
                  <th>This month</th><th>Last used</th><th>Status</th>
                  {isAdmin && <th />}
                </tr>
              </thead>
              <tbody>
                {(health ?? []).map((l: any) => {
                  const tone =
                    l.state === 'working' ? 'p-ok'
                    : l.state === 'revoked' || l.state === 'expired' || l.state === 'at limit' ? 'p-bad'
                    : l.state === 'quiet' || l.state === 'never used' ? 'p-mute'
                    : 'p-warn';
                  return (
                    <tr key={l.link_id}>
                      <td><div className="aname">{l.holder}</div></td>
                      <td style={{ color: 'var(--text-2)' }}>{l.location}</td>
                      <td>
                        {(l.verbs ?? []).map((v: string) => (
                          <span key={v} className="pill p-mute" style={{ marginRight: 4 }}>
                            {VERBS.find(([k]) => k === v)?.[1] ?? v}
                          </span>
                        ))}
                      </td>
                      <td className="mono">
                        {l.used_this_month}
                        {l.monthly_limit ? <span style={{ color: 'var(--text-3)' }}> / {l.monthly_limit}</span> : ''}
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>
                        {l.last_used_at
                          ? `${l.days_since_use} day${l.days_since_use === 1 ? '' : 's'} ago`
                          : 'never'}
                      </td>
                      <td>
                        <span className={`pill ${tone}`}><span className="pd" />{l.state}</span>
                        {l.days_left <= 14 && l.days_left >= 0 && (
                          <div className="amake" style={{ marginTop: 3 }}>
                            expires in {l.days_left} day{l.days_left === 1 ? '' : 's'}
                          </div>
                        )}
                      </td>
                      {isAdmin && (
                        <td style={{ textAlign: 'right' }}>
                          {l.state !== 'revoked' && (
                            <form action={revokeLink.bind(null, l.link_id)}>
                              <button className="btn btn-g" type="submit">Revoke</button>
                            </form>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin && (locations ?? []).length > 0 && (
        <form action={issueLink} className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Issue a link</div>
              <div className="card-s">Assume the URL will be forwarded, screenshotted and end up in a lost phone</div>
            </div>
          </div>
          <div style={{ padding: 20, display: 'grid', gap: 12, maxWidth: 520 }}>
            <input className="inp" name="name" placeholder="Their name" required />
            <input className="inp" name="role" placeholder="Storekeeper, driver, site clerk…" />
            <input className="inp" name="phone" placeholder="Phone number" />
            <select className="inp" name="location" required>
              {(locations ?? []).map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <div>
              <div className="lbl">What this link may do</div>
              {VERBS.map(([v, label]) => (
                <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, padding: '5px 0' }}>
                  <input type="checkbox" name="verb" value={v} defaultChecked={v === 'count' || v === 'fault'} />
                  {label}
                </label>
              ))}
            </div>
            <button className="btn btn-p" type="submit">Issue the link</button>
            <div className="hint">
              A link can never read the register, see costs, see another site, export or
              approve. Everything it sends queues for review, so the worst a stolen link
              can do is submit a wrong count.
            </div>
          </div>
        </form>
      )}
    </Shell>
  );
}
