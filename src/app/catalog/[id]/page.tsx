import Shell from '@/components/Shell';
import { sb, getSession, canWrite, canSeeFinancials, money } from '@/lib/session';
import { saveModelSpec } from '@/lib/actions';
import { AttrField } from '@/components/AttrField';

export const dynamic = 'force-dynamic';

export default async function ModelDetail({
  params, searchParams,
}: { params: { id: string }; searchParams: { saved?: string; error?: string } }) {
  const session = await getSession();
  const supabase = sb();

  const { data: model } = await supabase
    .from('models')
    .select(`id, name, introduced_year, service_life_years, warranty_months,
             service_interval, service_interval_unit, consumption_rate, list_cost_minor, notes,
             brands ( name ), sub_categories ( name, categories ( name ) )`)
    .eq('id', params.id)
    .maybeSingle();

  if (!model) {
    return (
      <Shell current="catalog" title="Model" subtitle="Not found">
        <div className="card"><div className="empty"><h4>No such model</h4>
        <p>It may have been removed, or belong to a company you are not in.</p>
        <a className="btn btn-g" href="/catalog" style={{ marginTop: 18 }}>Back to the catalog</a>
        </div></div>
      </Shell>
    );
  }

  const m = model as any;
  const [{ data: spec }, { data: units }] = await Promise.all([
    supabase.rpc('model_specification', { p_model: params.id }),
    supabase.from('assets')
      .select('id, tag, name, status, locations ( name )')
      .eq('model_id', params.id).order('tag'),
  ]);

  const rows = (spec ?? []) as any[];
  const owned = (units ?? []) as any[];
  const live = owned.filter((u) => u.status !== 'retired');
  const recorded = rows.filter((r) => r.value);

  return (
    <Shell
      current="catalog"
      title={`${m.brands?.name ?? ''} ${m.name}`.trim()}
      subtitle={`${m.sub_categories?.categories?.name ?? ''} · ${m.sub_categories?.name ?? ''}`}
    >
      {searchParams.saved && <div className="notice"><p>Specification saved.</p></div>}
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <a className="btn btn-g" href="/catalog">Back to the catalog</a>
        <a className="btn btn-g" href={`/assets?q=${encodeURIComponent(m.name)}`}>
          See the {live.length} unit{live.length === 1 ? '' : 's'} we own
        </a>
      </div>

      <div className="ovgrid">
        <div className="card ov-wide">
          <div className="card-h bd">
            <div>
              <div className="card-t">Specification</div>
              <div className="card-s">
                Recorded once here, and inherited by every unit. {recorded.length} of{' '}
                {rows.length} field{rows.length === 1 ? '' : 's'} filled in.
              </div>
            </div>
            <a className="btn btn-g" href="/catalog/attributes" style={{ marginLeft: 'auto' }}>
              Edit the fields
            </a>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              <h4>No fields defined for this category</h4>
              <p>
                Set up what a {m.sub_categories?.categories?.name ?? 'thing'} should be
                described by, and every model in it gets the same form.
              </p>
              <a className="btn btn-p" href="/catalog/attributes" style={{ marginTop: 18 }}>
                Set up the fields
              </a>
            </div>
          ) : canWrite(session) ? (
            <form action={saveModelSpec} style={{ padding: 20, display: 'grid', gap: 16 }}>
              <input type="hidden" name="model" value={params.id} />
              <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))' }}>
                {rows.map((r) => (
                  <AttrField key={r.code} code={r.code} label={r.label} kind={r.kind}
                             unit={r.unit} choices={r.choices} required={r.required}
                             value={r.value} help={r.help} />
                ))}
              </div>
              <div>
                <button className="btn btn-p" type="submit">Save the specification</button>
                <p className="hint" style={{ marginTop: 9 }}>
                  This changes the description of all {live.length} unit
                  {live.length === 1 ? '' : 's'}. If only one of them differs, record that on
                  the unit itself instead.
                </p>
              </div>
            </form>
          ) : (
            <div className="tbl-wrap">
              <table>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.code}>
                      <td style={{ color: 'var(--text-3)', width: 190 }}>{r.label}</td>
                      <td>{r.value ? `${r.value}${r.unit ? ' ' + r.unit : ''}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-h bd">
            <div><div className="card-t">Lifecycle</div>
            <div className="card-s">Inherited by every unit</div></div>
          </div>
          <div className="tbl-wrap">
            <table>
              <tbody>
                <tr><td style={{ color: 'var(--text-3)' }}>Service life</td>
                    <td>{m.service_life_years ? `${m.service_life_years} years` : '—'}</td></tr>
                <tr><td style={{ color: 'var(--text-3)' }}>Warranty</td>
                    <td>{m.warranty_months ? `${m.warranty_months} months` : '—'}</td></tr>
                <tr><td style={{ color: 'var(--text-3)' }}>Service every</td>
                    <td>{m.service_interval
                      ? `${Number(m.service_interval).toLocaleString()} ${m.service_interval_unit ?? ''}`
                      : '—'}</td></tr>
                {m.consumption_rate && (
                  <tr><td style={{ color: 'var(--text-3)' }}>Fuel use</td>
                      <td className="mono">{m.consumption_rate} L/hr</td></tr>
                )}
                {canSeeFinancials(session) && (
                  <tr><td style={{ color: 'var(--text-3)' }}>List cost</td>
                      <td className="mono">{money(m.list_cost_minor)}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Units we own</div>
              <div className="card-s">{live.length} in service{owned.length > live.length ? `, ${owned.length - live.length} retired` : ''}</div>
            </div>
          </div>
          {owned.length === 0 ? (
            <div className="empty" style={{ padding: '34px 20px' }}>
              <h4>None yet</h4>
              <p>Assets linked to this model appear here.</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Tag</th><th>Name</th><th>Location</th></tr></thead>
                <tbody>
                  {owned.slice(0, 12).map((u) => (
                    <tr key={u.id}>
                      <td><a className="tag" href={`/assets/${u.id}`}>{u.tag}</a></td>
                      <td>{u.name}</td>
                      <td style={{ color: 'var(--text-2)' }}>{u.locations?.name ?? 'in transit'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
