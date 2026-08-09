import Shell from '@/components/Shell';
import { sb } from '@/lib/session';
import { importAssets } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * Bulk import. Every real customer arrives with a spreadsheet, and without a
 * path from that spreadsheet into the register nobody onboards.
 *
 * The batch is inserted as one statement, so a duplicate tag or serial
 * anywhere rejects the whole thing. A half-imported register is worse than
 * none: you cannot tell which rows are real without re-reading the file line
 * by line.
 */
export default async function Import({
  searchParams,
}: { searchParams: { error?: string } }) {
  const { data: locations } = await sb()
    .from('locations').select('id, name, kind').is('archived_at', null).order('name');

  return (
    <Shell current="import" title="Import" subtitle="Bring an existing register in from a spreadsheet">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <form action={importAssets}>
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Paste your rows</div>
              <div className="card-s">
                Comma separated, with the column names on the first line. Only
                <span className="mono"> tag</span> and <span className="mono">name</span> are
                required; <span className="mono">serial</span> is used if present.
              </div>
            </div>
          </div>
          <div style={{ padding: 20 }}>
            <label className="lbl" htmlFor="location">Where these assets live</label>
            <select className="inp" id="location" name="location" required>
              {(locations ?? []).map((l: any) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.kind === 'virtual' ? ' (virtual warehouse)' : ''}
                </option>
              ))}
            </select>
            <div className="hint">
              Every row lands here. Move them afterwards with a transfer if they belong
              elsewhere — that way the movement is recorded rather than assumed.
            </div>

            <div style={{ height: 18 }} />
            <label className="lbl" htmlFor="csv">Rows</label>
            <textarea
              className="inp"
              id="csv"
              name="csv"
              rows={12}
              style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.7 }}
              defaultValue={'tag,name,serial\nNM-00010,Dell Latitude 5540,CN0X4K21-8801\nNM-00011,Dell Latitude 5540,CN0X4K21-8802\nNM-00012,HP LaserJet M428,'}
            />
            <div className="hint">
              A serial you already hold will reject the whole batch rather than create a
              second record for one physical machine. That is deliberate: duplicates are
              the hardest thing to unpick later.
            </div>
          </div>
        </div>

        <div className="notice">
          <p>
            <b>Nothing is written until you press import, and then it is all or nothing.</b>{' '}
            If any row fails — a duplicate tag, a serial already on the register — the whole
            batch is rejected and the message tells you which row to fix.
          </p>
        </div>

        <button className="btn btn-p" type="submit">Import these rows</button>
      </form>
    </Shell>
  );
}
