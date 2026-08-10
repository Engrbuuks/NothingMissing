import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';

/** CSV of the audit trail — what an auditor asks for on day one. */
export const dynamic = 'force-dynamic';

const esc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(request: Request) {
  const supabase = server(cookies());
  const url = new URL(request.url);
  const q = url.searchParams.get('q') ?? '';
  const entity = url.searchParams.get('entity');
  const tone = url.searchParams.get('tone');

  let query = supabase
    .from('audit_events')
    .select('occurred_at, actor_label, actor_kind, action, entity, reference, detail, tone, locations ( name )')
    .order('occurred_at', { ascending: false })
    .limit(5000);

  if (entity) query = query.eq('entity', entity);
  if (tone) query = query.eq('tone', tone);
  if (q) query = query.or(`action.ilike.%${q}%,detail.ilike.%${q}%,reference.ilike.%${q}%,actor_label.ilike.%${q}%`);

  const { data, error } = await query;
  if (error) return new Response(`Could not export: ${error.message}`, { status: 400 });

  const lines = ['occurred_at,actor,actor_kind,action,entity,reference,detail,severity,location'];
  for (const e of (data ?? []) as any[]) {
    lines.push([
      e.occurred_at, e.actor_label, e.actor_kind, e.action, e.entity,
      e.reference, e.detail, e.tone, e.locations?.name,
    ].map(esc).join(','));
  }

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('\uFEFF' + lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="audit-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
