import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';

/**
 * Serves a receipt to a reviewer through a short-lived signed URL.
 *
 * The storage path is never public. Handing out a direct URL would mean a
 * receipt stays reachable by anyone who ever saw the link, long after the
 * person stopped being a reviewer.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const supabase = server(cookies());
  const path = new URL(request.url).searchParams.get('path');
  if (!path) return new Response('No path', { status: 400 });

  // Reviewer check first. Without it this route would hand any signed-in user
  // any receipt, which would quietly undo the whole point of the narrow
  // cross-tenant exception.
  const { data: me } = await supabase.from('platform_reviewers').select('user_id').maybeSingle();
  if (!me) return new Response('Not permitted', { status: 403 });

  const { data, error } = await supabase.storage
    .from('receipts')
    .createSignedUrl(path, 120);   // two minutes is enough to look at it

  if (error || !data) {
    return new Response(`Could not open that receipt: ${error?.message ?? 'unknown'}`, { status: 404 });
  }
  return Response.redirect(data.signedUrl, 302);
}
