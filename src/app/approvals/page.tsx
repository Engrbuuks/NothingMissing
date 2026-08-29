import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { saveApprovalPolicy, deleteApprovalPolicy, saveExternalApprover,
         removeExternalApprover, setExternalQuorum } from '@/lib/actions';

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

  // Email approvers: people with no account who sign things off from a link.
  const companyId = (co as any)?.id ?? null;
  const [{ data: processes }, { data: approvers }, { data: scopes }, { data: quorum }] =
    await Promise.all([
      supabase.rpc('approval_processes'),
      supabase.from('external_approvers')
        .select('id, name, email, active').eq('active', true).order('name'),
      supabase.from('external_approver_scopes').select('approver_id, request_type'),
      supabase.from('external_quorum').select('request_type, mode'),
    ]);

  const people = (approvers ?? []) as any[];
  const scopeSet = new Set(
    ((scopes ?? []) as any[]).map((r) => `${r.approver_id}|${r.request_type}`),
  );
  const modeFor = (t: string) =>
    ((quorum ?? []) as any[]).find((q) => q.request_type === t)?.mode ?? 'any';
  const approversFor = (t: string) =>
    people.filter((p) => scopeSet.has(`${p.id}|${t}`));

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

      {/* ------------------------------------------------------------------ *
        * Approvers with no account.                                         *
        * ------------------------------------------------------------------ */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Approve by email</div>
            <div className="card-s">
              A name and an address is all it takes. They get a message with the request and
              two buttons, and never need an account — which is what the people who actually
              hold up a purchase order are never going to create.
            </div>
          </div>
        </div>

        <div style={{ padding: 20, display: 'grid', gap: 18 }}>
          {people.length === 0 && (
            <p className="hint" style={{ margin: 0 }}>
              Nobody yet. Add someone below and tick which kinds of request they should be
              asked about.
            </p>
          )}

          {people.map((p) => (
            <form key={p.id} action={saveExternalApprover}
                  style={{ display: 'grid', gap: 12, padding: 16,
                           border: '1px solid var(--line)', borderRadius: 'var(--r)' }}>
              <input type="hidden" name="approver" value={p.id} />
              <div style={{ display: 'grid', gap: 12,
                            gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
                <div>
                  <label className="lbl">Name</label>
                  <input className="inp" name="name" defaultValue={p.name}
                         disabled={!editable} required />
                </div>
                <div>
                  <label className="lbl">Email</label>
                  <input className="inp" name="email" type="email" defaultValue={p.email}
                         disabled={!editable} required />
                </div>
              </div>

              <div>
                <label className="lbl">Which processes they approve</label>
                <div className="chk-grid">
                  {((processes ?? []) as any[]).map((proc) => (
                    <label key={proc.request_type} className="chk">
                      <input type="checkbox" name="types" value={proc.request_type}
                             defaultChecked={scopeSet.has(`${p.id}|${proc.request_type}`)}
                             disabled={!editable} />
                      <span>
                        <b>{proc.label}</b>
                        <span className="hint" style={{ marginTop: 2 }}>{proc.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {editable && (
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-p" type="submit">Save</button>
                  <button className="btn btn-g" type="submit"
                          formAction={removeExternalApprover.bind(null, p.id)}
                          style={{ color: 'var(--bad)' }}>
                    Remove
                  </button>
                </div>
              )}
            </form>
          ))}

          {editable && (
            <form action={saveExternalApprover}
                  style={{ display: 'grid', gap: 12, padding: 16,
                           border: '1px dashed var(--line)', borderRadius: 'var(--r)' }}>
              {/* Empty, not absent. The action reads `approver` to decide
                  between an update and an insert, and a form that omits a
                  field its action reads sends null silently — which is the
                  exact failure tests-forms.mjs exists to catch, and did. */}
              <input type="hidden" name="approver" value="" />
              <div className="card-t" style={{ fontSize: 14 }}>Add an approver</div>
              <div style={{ display: 'grid', gap: 12,
                            gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
                <div>
                  <label className="lbl">Name</label>
                  <input className="inp" name="name" placeholder="e.g. Chief Adaeze" required />
                </div>
                <div>
                  <label className="lbl">Email</label>
                  <input className="inp" name="email" type="email"
                         placeholder="adaeze@example.com" required />
                </div>
              </div>
              <div>
                <label className="lbl">Which processes they approve</label>
                <div className="chk-grid">
                  {((processes ?? []) as any[]).map((proc) => (
                    <label key={proc.request_type} className="chk">
                      <input type="checkbox" name="types" value={proc.request_type} />
                      <span>
                        <b>{proc.label}</b>
                        <span className="hint" style={{ marginTop: 2 }}>{proc.detail}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div><button className="btn btn-p" type="submit">Add this approver</button></div>
            </form>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ *
        * How much agreement is needed.                                       *
        * ------------------------------------------------------------------ */}
      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">How many of them have to agree</div>
            <div className="card-s">
              Per process. A decline always ends the request whichever setting is chosen —
              that is a rule about how much agreement it takes to proceed, not licence to
              ignore somebody who said no.
            </div>
          </div>
        </div>
        <div style={{ padding: 20, display: 'grid', gap: 12 }}>
          {((processes ?? []) as any[]).map((proc) => {
            const n = approversFor(proc.request_type).length;
            return (
              <form key={proc.request_type} action={setExternalQuorum}
                    style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="hidden" name="request_type" value={proc.request_type} />
                <span style={{ flex: 1, minWidth: 180, fontSize: 13.5, fontWeight: 600 }}>
                  {proc.label}
                  <span className="hint" style={{ marginTop: 2 }}>
                    {n === 0
                      ? 'nobody assigned, so nothing is sent'
                      : `${n} approver${n === 1 ? '' : 's'}`}
                  </span>
                </span>
                <select className="inp" name="mode" defaultValue={modeFor(proc.request_type)}
                        disabled={!editable} style={{ maxWidth: 260 }}>
                  <option value="any">Any one of them is enough</option>
                  <option value="all">All of them must approve</option>
                </select>
                {editable && <button className="btn btn-g" type="submit">Save</button>}
              </form>
            );
          })}
        </div>
      </div>

      {!editable && (
        <p className="hint">Only an owner or admin can change who approves what.</p>
      )}
    </Shell>
  );
}
