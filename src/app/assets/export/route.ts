import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';

/**
 * CSV export of the register, honouring the same filters as the screen — what
 * downloads is what you were looking at.
 *
 * Cost columns are included only if the caller's role permits. That is not a
 * courtesy: an export is the easiest way to walk financial data out of a
 * system, so it asks the same question the register does and the database
 * gives the same answer.
 */
export const dynamic = 'force-dynamic';

const esc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  const supabase = server(cookies());
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const cat = url.searchParams.get('cat');
  const loc = url.searchParams.get('loc');
  const status = url.searchParams.get('status');

  let query = supabase
    .from('assets')
    .select(
      `id, tag, name, serial_no, status, holder, acquired_on, meter_value, meter_unit,
       locations ( name ),
       models ( name, brands ( name ), sub_categories ( name, categories ( id, name ) ) )`
    )
    .order('tag');

  if (loc) query = query.eq('location_id', loc);
  if (status) query = query.eq('status', status);
  if (q) {
    query = query.or(`tag.ilike.%${q}%,name.ilike.%${q}%,serial_no.ilike.%${q}%,holder.ilike.%${q}%`);
  }

  const { data, error } = await query;
  if (error) {
    return new Response(`Could not export: ${error.message}`, { status: 400 });
  }

  let rows = (data ?? []) as any[];
  if (cat) rows = rows.filter((a) => a.models?.sub_categories?.categories?.id === cat);

  // Ask for costs. An empty result means the role cannot see them, so the
  // column is dropped entirely rather than exported full of blanks — a blank
  // column invites someone to assume the data is missing rather than withheld.
  const { data: fin } = await supabase
    .from('asset_financials')
    .select('asset_id, purchase_cost_minor, invoice_ref, warranty_expires');
  const costs = new Map((fin ?? []).map((f: any) => [f.asset_id, f]));
  const withCosts = (fin ?? []).length > 0;

  const header = [
    'tag', 'name', 'serial', 'category', 'brand', 'model',
    'location', 'status', 'assigned_to', 'acquired_on', 'meter', 'meter_unit',
    ...(withCosts ? ['purchase_cost_naira', 'invoice_ref', 'warranty_expires'] : []),
  ];

  const lines = [header.join(',')];
  for (const a of rows) {
    const f = costs.get(a.id);
    const cells = [
      a.tag, a.name, a.serial_no,
      a.models?.sub_categories?.categories?.name,
      a.models?.brands?.name, a.models?.name,
      a.status === 'transit' ? 'In transit' : a.locations?.name,
      a.status, a.holder, a.acquired_on, a.meter_value, a.meter_unit,
      ...(withCosts
        ? [f?.purchase_cost_minor != null ? f.purchase_cost_minor / 100 : '', f?.invoice_ref, f?.warranty_expires]
        : []),
    ];
    lines.push(cells.map(esc).join(','));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('\uFEFF' + lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="register-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
