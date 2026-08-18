import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { saveApprovalPolicy, deleteApprovalPolicy } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const TYPES = [
  ['purchase', 'Buying something'],
  ['transfer', 'Moving assets between sites'],
  ['repair', 'Sending something for repair'],
  ['disposal', 'Writing something off'],
];

const ROLES = [
  ['manager', 'Manager'],
  ['admin', 'Admin'],
  ['owner', 'Owner'],
];

/**
 * Who approves what.
 *
 * This existed only as rows somebody had to insert by hand, which meant every
 * company ran on whatever the seed contained — or on nothing at all. The
 * approval chain is the heart of the product and it was configurable only in
 * SQL, which made it a feature in the documentation rather than in the
 * product.
 */
export default async function Approvals({
  searchParams,
}: { searchParams: { error?: string; saved?: string; removed?: string } }) {
  const session = await getSession();
  const supabase = sb();
  const editable = hasRole(session, 'owner', 'admin');

  const { data: co } = await supabase.from('companies').select('id').limit(1).maybeSingle();
  const { data: rules } = co
    ? await supabase.rpc('approval_rules', { p_company: (co as any).id })
    : { data: [] as any[] };

  const byType = (t: string) => ((rules ?? []) as any[]).filter((r) => r.request_type === t);

  return (
    <Shell current="approvals" title="Who approves what" subtitle="The rules that decide how many signatures something needs">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.saved && <div className="notice"><p>Saved. It applies to requests raised from now on.</p></div>}
      {searchParams.removed && <div className="notice"><p>Removed.</p></div>}

      <details className="explain">
        <summary>How the chain works</summary>
        <div className="explain-body">
          <div className="explain-grid">
            <div>
              <h4>Rules are matched, not stacked</h4>
              <p>
                The first rule whose conditions fit is the one that applies. Order them with
                the priority number — lower runs first — so a specific rule beats a general
                one.
              </p>
            </div>
            <div>
              <h4>Seniority covers a junior step</h4>
              <p>
                A chain of <b>manager, then admin</b> means two signatures. An owner can sign
                either slot, because seniority satisfies a junior step. Two people are still
                needed.
              </p>
            </div>
            <div>
              <h4>Nobody approves their own</h4>
              <p>
                Whoever raised it cannot sign for it, whatever their role. That is enforced in
                the database, not in this screen, so it holds however the request was made.
              </p>
            </div>
          </div>
          <p className="explain-test">
            <b>If no rule matches</b>, the request goes straight to an owner or admin. That is
            a safe default rather than a silent approval — but it means a request type with no
            rules is a request type nobody planned for.
          </p>
        </div>
      </details>

      {TYPES.map(([type, label]) => {
        const list = byType(type);
        return (
          <div className="card" key={type} style={{ marginBottom: 18 }}>
            <div className="card-h bd">
              <div>
                <div className="card-t">{label}</div>
                <div className="card-s">
                  {list.length === 0
                    ? 'No rules — these go straight to an owner or admin'
                    : `${list.length} rule${list.length === 1 ? '' : 's'}, first match wins`}
                </div>
              </div>
            </div>

            {list.length > 0 && (
              <div className="tbl-wrap">
                <table>
                  <thead>
                    <tr><th>Rule</th><th>Applies when</th><th>Signatures needed</th><th>Order</th>{editable && <th />}</tr>
                  </thead>
                  <tbody>
                    {list.map((r: any) => (
                      <tr key={r.id}>
                        <td><div className="aname">{r.name}</div></td>
                        <td style={{ color: 'var(--text-2)' }}>{r.applies_when || 'Always'}</td>
                        <td>
                          {(r.chain ?? []).map((c: string, i: number) => (
                            <span key={i}>
                              <span className="pill p-mute">{c}</span>
                              {i < r.chain.length - 1 && (
                                <span style={{ margin: '0 5px', color: 'var(--text-3)' }}>then</span>
                              )}
                            </span>
                          ))}
                        </td>
                        <td className="mono" style={{ color: 'var(--text-3)' }}>{r.priority}</td>
                        {editable && (
                          <td style={{ textAlign: 'right' }}>
                            <form action={deleteApprovalPolicy.bind(null, r.id)}>
                              <button className="btn btn-g" type="submit"
                                      style={{ padding: '5px 10px', fontSize: 12, color: 'var(--bad)' }}>
                                Remove
                              </button>
                            </form>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {editable && (
              <form action={saveApprovalPolicy}
                    style={{ padding: 20, borderTop: '1px solid var(--line-2)', display: 'grid', gap: 14 }}>
                <input type="hidden" name="type" value={type} />
                {/* Empty means "new". The action treats a blank id as an insert,
                    so one form serves both without a second code path. */}
                <input type="hidden" name="id" value="" />

                <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
                  <div>
                    <label className="lbl">Name this rule</label>
                    <input className="inp" name="name" required
                           placeholder={type === 'purchase' ? 'Purchases over NGN 500,000' : 'Anything over 5 assets'} />
                  </div>
                  <div>
                    <label className="lbl">Signatures, in order</label>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 6 }}>
                      {ROLES.map(([v, l]) => (
                        <label key={v} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                          <input type="checkbox" name="chain" value={v} />
                          {l}
                        </label>
                      ))}
                    </div>
                    <div className="hint">Signed in the order shown: manager, then admin, then owner.</div>
                  </div>
                  <div>
                    <label className="lbl">Order</label>
                    <input className="inp" name="priority" type="number" defaultValue={50} />
                    <div className="hint">Lower runs first.</div>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
                  <div>
                    <label className="lbl">From (naira)</label>
                    <input className="inp" name="min_amount" placeholder="any" />
                  </div>
                  <div>
                    <label className="lbl">Up to (naira)</label>
                    <input className="inp" name="max_amount" placeholder="any" />
                  </div>
                  <div>
                    <label className="lbl">From (items)</label>
                    <input className="inp" name="min_items" type="number" min="0" placeholder="any" />
                  </div>
                  <div>
                    <label className="lbl">Up to (items)</label>
                    <input className="inp" name="max_items" type="number" min="0" placeholder="any" />
                  </div>
                </div>

                <div><button className="btn btn-p" type="submit">Add this rule</button></div>
              </form>
            )}
          </div>
        );
      })}

      {!editable && (
        <p className="hint">Only an owner or admin can change who approves what.</p>
      )}
    </Shell>
  );
}
