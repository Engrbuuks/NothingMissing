import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';

/**
 * A person's own data, as JSON.
 *
 * The privacy notice promises this, and answering by hand is how a small
 * company misses the 30-day deadline. It is a route rather than a page so the
 * browser downloads it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = server(cookies());
  const { data, error } = await supabase.rpc('export_my_data');

  if (error) return new Response(`Could not export: ${error.message}`, { status: 400 });

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="my-data-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
