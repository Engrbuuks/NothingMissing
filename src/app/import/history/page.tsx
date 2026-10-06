import Shell from '@/components/Shell';
import { sb, getSession, hasRole } from '@/lib/session';
import { undoAssetImport } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * What each import did, and how to take one back.
 *
 * This page exists because of a specific failure. The tag generator made the
 * import quadratic, so a real file ran past the gateway timeout. The request
 * died; the transaction did not. Postgres finished, committed, and said nothing
 * to anybody. The button looked dead, so it got pressed again, and the register
 * ended up holding several identical copies of one spreadsheet.
 *
 * The import is fast now, but nothing in the product could see that duplication
 * or undo it, and the same shape would return the next time anything timed out.
 * So the runs are listed, repeats are named as repeats, and a run can be
 * removed in one action.
 *
 * Runs are reconstructed from the audit log rather than from a new table, which
 * means every past import is here too, including the ones that caused this.
 */
export default async function ImportHistory({
  searchParams,
}: {
  searchParams: { error?: string; done?: string };
}) {
  const session = await getSession();
  const mayUndo = hasRole(session, 'owner', 'admin');

  const { data: co } = await sb().from('companies').select('id').limit(1).maybeSingle();
  const { data, error } = co
    ? await sb().rpc('asset_import_runs', { p_company: (co as any).id })
    : { data: null, error: null as any };

  const runs = (data ?? []) as {
    run_id: number;
    occurred_at: string;
    actor: string | null;
    location: string | null;
    reported: number | null;
    still_present: number;
    removable: number;
    in_use: number;
    repeat_of: number | null;
  }[];

  const repeats = runs.filter((r) => r.repeat_of !== null && r.still_present > 0);
  const duplicated = repeats.reduce((n, r) => n + r.still_present, 0);

  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });

  return (
    <Shell current="import" title="Import history" subtitle="Every import, and what it put on the register">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}
      {searchParams.done && <div className="notice ok"><p>{searchParams.done}</p></div>}
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      <div className="segmented" style={{ marginBottom: 16 }}>
        <a href="/import">Assets</a>
        <a href="/import?kind=stock">Inventory</a>
        <a className="on" href="/import/history">History</a>
      </div>

      {repeats.length > 0 && (
        <div className="notice warn">
          <p>
            <b>
              {repeats.length === 1
                ? 'One import looks like a repeat of an earlier one'
                : `${repeats.length} imports look like repeats of earlier ones`}
              , holding {duplicated.toLocaleString()} asset
              {duplicated === 1 ? '' : 's'} between them.
            </b>{' '}
            A repeat is an import whose rows match an earlier one at the same place, which is
            what happens when a slow import is pressed twice. The earliest one is never
            marked as a repeat, so removing the ones marked here leaves exactly one copy.
          </p>
        </div>
      )}

      {runs.length === 0 && (
        <div className="card">
          <div className="empty">
            <h4>Nothing has been imported yet</h4>
            <p>When you import a spreadsheet it will be listed here, with a way to take it
              back off the register if it was not what you meant.</p>
            <a className="btn btn-p" href="/import" style={{ marginTop: 18 }}>Import a spreadsheet</a>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Imports</div>
              <div className="card-s">Most recent first</div>
            </div>
          </div>
          <div className="tw">
            <table className="tb">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Where</th>
                  <th>By</th>
                  <th className="num">On the register</th>
                  <th className="num">In use</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      {when(r.occurred_at)}
                      {r.repeat_of !== null && r.still_present > 0 && (
                        <span className="pill p-warn" style={{ marginLeft: 8 }}>repeat</span>
                      )}
                    </td>
                    <td>{r.location ?? 'Not recorded'}</td>
                    <td style={{ color: 'var(--text-2)' }}>{r.actor ?? 'Not recorded'}</td>
                    <td className="num">
                      {r.still_present.toLocaleString()}
                      {r.reported !== null && r.reported !== r.still_present && (
                        <span style={{ color: 'var(--text-2)' }}> of {r.reported.toLocaleString()}</span>
                      )}
                    </td>
                    <td className="num">
                      {r.in_use > 0 ? r.in_use.toLocaleString() : <span style={{ color: 'var(--text-2)' }}>none</span>}
                    </td>
                    <td className="num">
                      {r.still_present === 0 ? (
                        <span style={{ color: 'var(--text-2)' }}>already removed</span>
                      ) : !mayUndo ? (
                        <span style={{ color: 'var(--text-2)' }}>owner or admin</span>
                      ) : r.removable === 0 ? (
                        <span style={{ color: 'var(--text-2)' }}>all in use</span>
                      ) : (
                        <form action={undoAssetImport}>
                          <input type="hidden" name="run" value={r.run_id} />
                          <input type="hidden" name="expect" value={r.removable} />
                          <button className="btn btn-g" type="submit">
                            Remove {r.removable.toLocaleString()}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="notice" style={{ marginTop: 16 }}>
          <p>
            <b>An asset that has been used is never removed.</b> If it has moved, been handed
            to somebody, been serviced, photographed, counted or named on a request, it stays
            and is counted under <i>In use</i>. Those are the ones where the import has stopped
            being the whole story, and removing them would take somebody else work with it.
            Every removal is written to the audit log against the tag it carried.
          </p>
        </div>
      )}
    </Shell>
  );
}
