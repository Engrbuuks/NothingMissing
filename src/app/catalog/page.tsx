import Shell from '@/components/Shell';
import { sb, canSeeFinancials, getSession, money } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Category → type → brand → model → the units you own.
 *
 * The model holds the specification once and every unit inherits it. That is
 * what makes "how reliable is the Cummins C250" an answerable question rather
 * than a pattern you have to spot across rows that happen to be spelled alike.
 */
export default async function Catalog() {
  const session = await getSession();
  const supabase = sb();
  const showCost = canSeeFinancials(session);

  const { data: models, error } = await supabase
    .from('models')
    .select(`id, name, introduced_year, service_life_years, warranty_months,
             list_cost_minor, specs, consumption_rate, consumption_unit,
             brands ( name, colour_hex ),
             sub_categories ( name, categories ( name, colour_hex ) )`)
    .order('name');

  const { data: assets } = await supabase.from('assets').select('model_id');
  const owned = new Map<string, number>();
  (assets ?? []).forEach((a: any) => {
    if (a.model_id) owned.set(a.model_id, (owned.get(a.model_id) ?? 0) + 1);
  });

  const list = (models ?? []) as any[];

  // Group by category so the hierarchy is visible rather than implied.
  const byCategory = new Map<string, any[]>();
  list.forEach((m) => {
    const cat = m.sub_categories?.categories?.name ?? 'Uncategorised';
    byCategory.set(cat, [...(byCategory.get(cat) ?? []), m]);
  });

  return (
    <Shell current="catalog" title="Catalog" subtitle="What a thing is, held once and inherited by every unit">
      {error && <div className="notice bad"><p>{error.message}</p></div>}

      {list.length === 0 ? (
        <div className="card">
          <div className="empty">
            <h4>No models yet</h4>
            <p>
              A model carries the specification, warranty term, service life and service
              interval. Add one and every unit you buy inherits all of it — you enter it
              once instead of once per machine.
            </p>
          </div>
        </div>
      ) : (
        [...byCategory.entries()].map(([cat, models]) => (
          <div className="card" key={cat} style={{ marginBottom: 18 }}>
            <div className="card-h bd">
              <div>
                <div className="card-t">{cat}</div>
                <div className="card-s">{models.length} model{models.length === 1 ? '' : 's'}</div>
              </div>
            </div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Brand</th><th>Model</th><th>Type</th><th>Units owned</th>
                    <th>Service life</th><th>Warranty</th>{showCost && <th>List cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m: any) => (
                    <tr key={m.id}>
                      <td>
                        <span className="pill" style={{
                          background: (m.brands?.colour_hex ?? '#5B4BE8') + '1A',
                          color: m.brands?.colour_hex ?? '#5B4BE8',
                        }}>
                          {m.brands?.name ?? 'Unbranded'}
                        </span>
                      </td>
                      <td>
                        <div className="aname">{m.name}</div>
                        <div className="amake">
                          {(m.specs ?? []).slice(0, 2).map((s: any) => s[1]).join(' · ')}
                          {m.consumption_rate ? ` · ${m.consumption_rate} ${m.consumption_unit === 'per_hour' ? 'per hour' : 'per km'}` : ''}
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-2)' }}>{m.sub_categories?.name ?? '—'}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{owned.get(m.id) ?? 0}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.service_life_years ? `${m.service_life_years} years` : '—'}</td>
                      <td style={{ color: 'var(--text-2)' }}>{m.warranty_months ? `${m.warranty_months} months` : '—'}</td>
                      {showCost && <td className="mono" style={{ fontSize: 12.5 }}>{money(m.list_cost_minor)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}
    </Shell>
  );
}
