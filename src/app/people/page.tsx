import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { issueLink, revokeLink } from '@/lib/actions';

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
}: { searchParams: { token?: string; slug?: string; error?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const isAdmin = hasRole(session, 'owner', 'admin');

  const { data: members } = await supabase
    .from('memberships')
    .select('id, role, location_id, profiles ( full_name, email ), locations ( name )');

  const { data: links } = await supabase
    .from('location_links')
    .select(`id, slug, verbs, expires_on, used_count, last_used_at, revoked_at,
             link_holders ( name, role_label, phone ), locations ( name )`)
    .is('revoked_at', null);

  const { data: locations } = await supabase
    .from('locations').select('id, name').is('archived_at', null).order('name');

  const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';

  return (
    <Shell current="people" title="People" subtitle="Accounts, and the people who hold a link instead">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

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
            <thead><tr><th>Person</th><th>Role</th><th>Scope</th></tr></thead>
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
              <thead><tr><th>Holder</th><th>Location</th><th>Can do</th><th>Used</th><th>Expires</th>{isAdmin && <th />}</tr></thead>
              <tbody>
                {(links ?? []).map((l: any) => (
                  <tr key={l.id}>
                    <td>
                      <div className="aname">{l.link_holders?.name ?? '—'}</div>
                      <div className="amake">{l.link_holders?.role_label ?? ''} {l.link_holders?.phone ?? ''}</div>
                    </td>
                    <td style={{ color: 'var(--text-2)' }}>{l.locations?.name ?? '—'}</td>
                    <td>
                      {(l.verbs ?? []).map((v: string) => (
                        <span key={v} className="pill p-mute" style={{ marginRight: 4 }}>
                          {VERBS.find(([k]) => k === v)?.[1] ?? v}
                        </span>
                      ))}
                    </td>
                    <td className="mono">{l.used_count}</td>
                    <td style={{ color: 'var(--text-2)' }}>{l.expires_on}</td>
                    {isAdmin && (
                      <td style={{ textAlign: 'right' }}>
                        <form action={revokeLink.bind(null, l.id)}>
                          <button className="btn btn-g" type="submit">Revoke</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
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
