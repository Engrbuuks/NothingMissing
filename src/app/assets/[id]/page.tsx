import Shell from '@/components/Shell';
import { sb, getSession, canSeeFinancials, canWrite, money } from '@/lib/session';
import { handOver, disposeAsset, saveAssetAttribute } from '@/lib/actions';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: 'In service', cls: 'p-ok' },
  transit: { label: 'In transit', cls: 'p-sky' },
  repair: { label: 'In repair', cls: 'p-warn' },
  idle: { label: 'Unassigned', cls: 'p-mute' },
  retired: { label: 'Retired', cls: 'p-bad' },
};

const DISPOSAL = [
  ['sold', 'Sold', 'Went to a buyer. Records proceeds against book value so the gain or loss is visible.'],
  ['scrapped', 'Scrapped', 'Beyond economic repair and destroyed. Needs a scrap note reference.'],
  ['stolen', 'Stolen', 'Needs a police report reference. Feeds the loss report and any claim.'],
  ['lost', 'Lost', 'Cannot be found and nobody knows why. The honest option, and the one auditors look at hardest.'],
  ['donated', 'Donated', 'Given away. Book value is cleared but the recipient is recorded.'],
  ['traded', 'Traded in', 'Went towards a replacement.'],
];

export default async function AssetDetail({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { error?: string; handed?: string; added?: string; saved?: string };
}) {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const { data: asset } = await supabase
    .from('assets')
    .select(
      `id, tag, name, serial_no, status, holder, acquired_on, meter_value, meter_unit,
       disposed_on, disposal_reason, disposal_ref,
       locations ( name ),
       models ( id, name, service_life_years, warranty_months, spares, specs,
                brands ( name ), sub_categories ( name ) )`
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!asset) {
    return (
      <Shell current="assets" title="Asset" subtitle="Not found">
        <div className="card">
          <div className="empty">
            <h4>No asset with that reference</h4>
            <p>
              It may be at a location outside your scope, in which case the database returns
              nothing rather than a filtered view. That is the same answer it gives for an
              asset that does not exist, deliberately.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const a = asset as any;
  const st = STATUS[a.status] ?? STATUS.idle;

  // Financials sit in their own table behind their own policy. A manager
  // asking for them gets no row back at all — nothing to blank out here.
  let cost: number | null = null;
  let supplier: string | null = null;
  let invoice: string | null = null;
  let warranty: string | null = null;
  if (showCost) {
    const { data: fin } = await supabase
      .from('asset_financials')
      .select('purchase_cost_minor, invoice_ref, warranty_expires')
      .eq('asset_id', params.id)
      .maybeSingle();
    cost = (fin as any)?.purchase_cost_minor ?? null;
    invoice = (fin as any)?.invoice_ref ?? null;
    warranty = (fin as any)?.warranty_expires ?? null;
  }

  // The custody chain. This is what someone screenshots when there is a
  // dispute, so it gets room and reads in plain language.
  const { data: spec } = await supabase.rpc('asset_specification', { p_asset: params.id });
  const specRows = (spec ?? []) as any[];
  const recorded = specRows.filter((r) => r.value);

  const { data: events } = await supabase
    .from('audit_events')
    .select('id, occurred_at, actor_label, action, detail, reference, tone')
    .eq('entity_id', params.id)
    .order('occurred_at', { ascending: false })
    .limit(50);

  const { data: services } = await supabase
    .from('maintenance_events')
    .select('id, performed_on, kind, cost_minor, vendor, note')
    .eq('asset_id', params.id)
    .order('performed_on', { ascending: false });

  const year = new Date().getFullYear();
  const age = a.acquired_on ? Math.max(0, year - new Date(a.acquired_on).getFullYear()) : null;
  const life = a.models?.service_life_years ?? null;
  const book = cost !== null && life ? Math.round(cost * (1 - Math.min(1, (age ?? 0) / life))) : null;

  return (
    <Shell current="assets" title={a.name} subtitle={a.tag}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <a className="btn btn-g" href="/assets">Back to the register</a>
        {canWrite(session) && (
          <a className="btn btn-p" href={`/assets/${a.id}/edit`} style={{ marginLeft: 'auto' }}>
            Edit
          </a>
        )}
      </div>
      {searchParams.added && (
        <div className="notice"><p>Added to the register.</p></div>
      )}
      {searchParams.saved && (
        <div className="notice"><p>Saved. The audit log records exactly what changed.</p></div>
      )}
      {searchParams.error && (
        <div className="notice bad">
          <p>{searchParams.error}</p>
        </div>
      )}
      {searchParams.handed && (
        <div className="notice">
          <p>Custody updated, and the change is on the audit log with your name against it.</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">{a.name}</div>
            <div className="card-s">
              {a.models?.brands?.name ? `${a.models.brands.name} · ` : ''}
              {a.models?.name ?? 'No catalog model'}
              {a.models?.sub_categories?.name ? ` · ${a.models.sub_categories.name}` : ''}
            </div>
          </div>
          <span className={`pill ${st.cls}`} style={{ marginLeft: 'auto' }}>
            <span className="pd" />
            {st.label}
          </span>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Tag</td>
                <td className="mono">{a.tag}</td>
                <td style={{ color: 'var(--text-3)' }}>Serial</td>
                <td className="mono">{a.serial_no ?? '—'}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Location</td>
                <td>{a.status === 'transit' ? 'In transit' : a.locations?.name ?? '—'}</td>
                <td style={{ color: 'var(--text-3)' }}>Assigned to</td>
                <td>{a.holder ?? 'Unassigned'}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--text-3)' }}>Acquired</td>
                <td>{a.acquired_on ?? '—'}{age !== null ? ` · ${age} year${age === 1 ? '' : 's'} old` : ''}</td>
                <td style={{ color: 'var(--text-3)' }}>Meter</td>
                <td className="mono">{a.meter_value ? `${a.meter_value} ${a.meter_unit ?? ''}` : '—'}</td>
              </tr>
              {showCost && (
                <tr>
                  <td style={{ color: 'var(--text-3)' }}>Purchase cost</td>
                  <td className="mono">{money(cost)}</td>
                  <td style={{ color: 'var(--text-3)' }}>Book value today</td>
                  <td className="mono">{book !== null ? money(book) : '—'}</td>
                </tr>
              )}
              {showCost && (invoice || warranty) && (
                <tr>
                  <td style={{ color: 'var(--text-3)' }}>Invoice</td>
                  <td className="mono">{invoice ?? '—'}</td>
                  <td style={{ color: 'var(--text-3)' }}>Warranty until</td>
                  <td>{warranty ?? '—'}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {!showCost && (
          <p className="hint" style={{ padding: '14px 20px' }}>
            Purchase cost, supplier and invoice sit behind a separate permission. The
            database sent no financial row for this asset, so there is nothing here to
            blank out.
          </p>
        )}
      </div>

      {a.models?.specs && Array.isArray(a.models.specs) && a.models.specs.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Specification</div>
              <div className="card-s">
                Held once on the catalog model. Every unit inherits it, so it cannot drift
                from one asset to the next.
              </div>
            </div>
          </div>
          <div style={{ padding: '6px 20px 18px' }}>
            {a.models.specs.map((s: any, i: number) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  padding: '11px 0',
                  borderBottom: '1px solid var(--line-2)',
                  fontSize: 13,
                }}
              >
                <span style={{ color: 'var(--text-3)' }}>{s[0]}</span>
                <span style={{ fontWeight: 600, textAlign: 'right' }}>{s[1]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {canWrite(session) && a.status !== 'retired' && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Hand over custody</div>
              <div className="card-s">
                A person accepting responsibility, not just a name in a box
              </div>
            </div>
          </div>
          <form
            action={handOver}
            style={{ padding: 20, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}
          >
            <input type="hidden" name="id" value={a.id} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <label className="lbl" htmlFor="holder">Hand over to</label>
              <input className="inp" id="holder" name="holder" defaultValue={a.holder ?? ''} placeholder="Person, team or room" />
            </div>
            <div style={{ minWidth: 200 }}>
              <label className="lbl" htmlFor="condition">Condition at handover</label>
              <select className="inp" id="condition" name="condition">
                <option>Good working order</option>
                <option>Working, cosmetic damage</option>
                <option>Working with a known fault</option>
              </select>
            </div>
            <button className="btn btn-p" type="submit">Record the handover</button>
          </form>
        </div>
      )}

      {specRows.length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Specification</div>
              <div className="card-s">
                Inherited from the catalog model, except where this particular unit differs
              </div>
            </div>
            {a.models && (
              <a className="btn btn-g" href={`/catalog/${a.models?.id}`} style={{ marginLeft: 'auto' }}>
                Edit the model
              </a>
            )}
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Field</th><th>Value</th><th>From</th></tr>
              </thead>
              <tbody>
                {specRows.map((r) => (
                  <tr key={r.code}>
                    <td style={{ color: 'var(--text-3)', width: 200 }}>{r.label}</td>
                    <td>
                      {r.value ? (
                        <>
                          <b>{r.value}</b>
                          {r.unit && <span style={{ color: 'var(--text-3)' }}> {r.unit}</span>}
                          {r.note && <div className="amake" style={{ marginTop: 3 }}>{r.note}</div>}
                        </>
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {r.source === 'this unit' ? (
                        <span className="pill p-warn"><span className="pd" />This unit only</span>
                      ) : r.source === 'model' ? (
                        <span className="pill p-mute">Model</span>
                      ) : (
                        <span style={{ color: 'var(--text-3)', fontSize: 12.5 }}>not recorded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canWrite(session) && (
            <form action={saveAssetAttribute}
                  style={{ padding: 20, borderTop: '1px solid var(--line-2)', display: 'grid', gap: 12 }}>
              <input type="hidden" name="asset" value={params.id} />
              <div className="card-t" style={{ fontSize: 14 }}>Record a difference</div>
              <p className="hint" style={{ marginTop: -4 }}>
                Only for something true of this unit and not of the model — memory upgraded,
                reupholstered in a different fabric. Changing the model would silently rewrite
                the description of every other unit.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <select className="inp" name="code" required style={{ flex: 1, minWidth: 160 }}>
                  {specRows.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
                <input className="inp" name="value" placeholder="New value"
                       style={{ flex: 1, minWidth: 140 }} />
                <input className="inp" name="note" placeholder="Why, and when"
                       style={{ flex: 1, minWidth: 160 }} />
                <button className="btn btn-p" type="submit">Record it</button>
              </div>
            </form>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Custody history</div>
            <div className="card-s">
              Append-only. Nothing here can be edited or deleted, by anyone.
            </div>
          </div>
        </div>
        {(events ?? []).length === 0 ? (
          <div className="empty">
            <h4>Nothing recorded yet</h4>
            <p>Movements, repairs and handovers appear here as they happen.</p>
          </div>
        ) : (
          <div style={{ padding: '4px 20px 18px' }}>
            {(events ?? []).map((e: any) => (
              <div
                key={e.id}
                style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--line-2)' }}
              >
                <span
                  className={`pill ${e.tone === 'ok' ? 'p-ok' : e.tone === 'warn' ? 'p-warn' : e.tone === 'bad' ? 'p-bad' : 'p-mute'}`}
                  style={{ flex: 'none', alignSelf: 'flex-start' }}
                >
                  <span className="pd" />
                  {e.action}
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}>{e.detail ?? '—'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4 }}>
                    {e.actor_label} · {new Date(e.occurred_at).toLocaleString('en-GB')}
                    {e.reference ? ` · ${e.reference}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {(services ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-h bd">
            <div>
              <div className="card-t">Service record</div>
              <div className="card-s">Every service and repair on this unit</div>
            </div>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>What</th><th>Vendor</th>{showCost && <th>Cost</th>}</tr>
              </thead>
              <tbody>
                {(services ?? []).map((s: any) => (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--text-2)' }}>{s.performed_on}</td>
                    <td>{s.kind ?? '—'}{s.note ? ` · ${s.note}` : ''}</td>
                    <td style={{ color: 'var(--text-2)' }}>{s.vendor ?? '—'}</td>
                    {showCost && <td className="mono" style={{ fontSize: 12.5 }}>{money(s.cost_minor)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {a.status === 'retired' ? (
        <div className="notice warn">
          <p>
            <b>Disposed of on {a.disposed_on}</b> — {a.disposal_reason}
            {a.disposal_ref ? ` · reference ${a.disposal_ref}` : ''}. It stays visible here
            and on every waybill it ever appeared on, but it has left every live register.
          </p>
        </div>
      ) : (
        canSeeFinancials(session) && (
          <div className="card">
            <div className="card-h bd">
              <div>
                <div className="card-t">Take it off the register</div>
                <div className="card-s">
                  Disposal is the step auditors examine hardest, because it is where things
                  quietly vanish
                </div>
              </div>
            </div>
            <form action={disposeAsset} style={{ padding: 20 }}>
              <input type="hidden" name="id" value={a.id} />
              <label className="lbl" htmlFor="reason">How did it leave the company?</label>
              <select className="inp" id="reason" name="reason" required>
                {DISPOSAL.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <div className="hint">
                {DISPOSAL.map(([v, l, d]) => (
                  <div key={v} style={{ marginTop: 4 }}>
                    <b>{l}:</b> {d}
                  </div>
                ))}
              </div>

              <div style={{ height: 16 }} />
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
                <div>
                  <label className="lbl" htmlFor="proceeds">Proceeds, if sold or traded</label>
                  <input className="inp" id="proceeds" name="proceeds" placeholder="e.g. 180,000" />
                </div>
                <div>
                  <label className="lbl" htmlFor="evidence">Reference, if stolen or scrapped</label>
                  <input className="inp" id="evidence" name="evidence" placeholder="Police report or scrap note" />
                </div>
              </div>

              <div style={{ height: 12 }} />
              <label className="lbl" htmlFor="note">What happened</label>
              <input className="inp" id="note" name="note" placeholder="A sentence that will still make sense in three years" />

              <div className="notice warn" style={{ marginTop: 16 }}>
                <p>
                  Disposal cannot be undone from here. The evidence rules are enforced by the
                  database, not this form — a theft without a reference is refused outright,
                  because that is exactly the pattern an audit flags.
                </p>
              </div>

              <button className="btn btn-p" type="submit">Dispose of this asset</button>
            </form>
          </div>
        )
      )}
    </Shell>
  );
}
