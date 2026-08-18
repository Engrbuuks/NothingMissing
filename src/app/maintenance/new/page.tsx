import Shell from '@/components/Shell';
import { sb, getSession, canWrite, canSeeFinancials } from '@/lib/session';
import { logMaintenance } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Recording maintenance on any asset.
 *
 * The maintenance page only offered actions on machines the system had already
 * flagged as due by their service interval. A generator that broke on a
 * Tuesday had nowhere to be recorded — and machines do not break on schedule,
 * which is most of the point of tracking them.
 */
export default async function NewMaintenance({
  searchParams,
}: { searchParams: { error?: string; asset?: string } }) {
  const session = await getSession();
  const supabase = sb();

  if (!canWrite(session)) {
    return (
      <Shell current="maintenance" title="Log maintenance" subtitle="">
        <div className="card"><div className="empty">
          <h4>Your role cannot record maintenance</h4>
          <p>An auditor reads everything and changes nothing — deliberately.</p>
        </div></div>
      </Shell>
    );
  }

  const { data: assets } = await supabase
    .from('assets')
    .select('id, tag, name, status, locations ( name ), models ( name, brands ( name ) )')
    .neq('status', 'retired')
    .order('tag');

  return (
    <Shell current="maintenance" title="Log maintenance" subtitle="A service done, or a fault found">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={logMaintenance}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">What happened, and to what</div>
              <div className="card-s">
                Recording a repair moves the asset out of service until somebody returns it —
                so the register stops claiming it is available when it is on a workbench
              </div>
            </div>
          </div>

          <div style={{ padding: 20, display: 'grid', gap: 16 }}>
            <div>
              <label className="lbl" htmlFor="asset">Asset</label>
              <select className="inp" id="asset" name="asset" required
                      defaultValue={searchParams.asset ?? ''}>
                <option value="" disabled>Choose the machine</option>
                {(assets ?? []).map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.tag} — {a.name}
                    {a.locations?.name ? ` (${a.locations.name})` : ''}
                    {a.status === 'repair' ? ' · already in repair' : ''}
                  </option>
                ))}
              </select>
              {(assets ?? []).length === 0 && (
                <div className="hint">
                  Nothing on the register yet —{' '}
                  <a href="/import" style={{ textDecoration: 'underline' }}>import your assets</a> first.
                </div>
              )}
            </div>

            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))' }}>
              <div>
                <label className="lbl" htmlFor="kind">What kind</label>
                <select className="inp" id="kind" name="kind" defaultValue="repair">
                  <option value="repair">Repair — something broke</option>
                  <option value="routine">Routine service — scheduled work</option>
                  <option value="inspection">Inspection — checked, nothing done</option>
                  <option value="calibration">Calibration</option>
                </select>
                <div className="hint">
                  A repair takes it out of service. An inspection does not.
                </div>
              </div>

              <div>
                <label className="lbl" htmlFor="vendor">Who did the work</label>
                <input className="inp" id="vendor" name="vendor"
                       placeholder="In-house, or the workshop's name" />
                <div className="hint">
                  Naming the workshop is what lets you see who keeps sending things back.
                </div>
              </div>

              {canSeeFinancials(session) && (
                <div>
                  <label className="lbl" htmlFor="cost">Cost</label>
                  <input className="inp" id="cost" name="cost" placeholder="e.g. 45,000" />
                  <div className="hint">Adds up against the asset over its life.</div>
                </div>
              )}
            </div>

            <div>
              <label className="lbl" htmlFor="note">What was wrong, or what was done</label>
              <input className="inp" id="note" name="note" required
                     placeholder="e.g. Starter motor failed, replaced with a rebuilt unit" />
              <div className="hint">
                Write it for somebody reading it in a year who was not there. &ldquo;Fixed&rdquo;
                tells them nothing.
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <a className="btn btn-g" href="/maintenance">Cancel</a>
          <button className="btn btn-p" type="submit" style={{ marginLeft: 'auto' }}>
            Record it
          </button>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          This goes on the asset&rsquo;s permanent history with your name and the date. If the
          work needs approving or paying for first, raise a{' '}
          <a href="/requests/new" style={{ textDecoration: 'underline' }}>request</a> instead.
        </p>
      </form>
    </Shell>
  );
}
