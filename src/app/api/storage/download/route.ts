import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';
import { signDownload, usingR2 } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reads a private object, after checking the caller may.
 *
 * The key encodes bucket and company — `receipts/<company>/<file>` — so the
 * check is: are you a member of that company, or a platform reviewer looking
 * at a receipt? Nothing is served without one of those being true, and the
 * signature that comes back lives for two minutes.
 */
export async function GET(request: Request) {
  if (!usingR2()) {
    return new Response('Storage is not configured.', { status: 501 });
  }

  const key = new URL(request.url).searchParams.get('key');
  if (!key) return new Response('No key', { status: 400 });

  const [bucket, companyId] = key.split('/');
  if (!bucket || !companyId) return new Response('Bad key', { status: 400 });
  if (bucket === 'branding') {
    // Public assets do not come through here; serving them signed would break
    // a printed waybill the moment the signature expired.
    return new Response('Use the public URL', { status: 400 });
  }

  const supabase = server(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response('Not signed in', { status: 401 });

  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id')
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();

  let allowed = Boolean(membership);

  // A platform reviewer may open a receipt from any company — the one
  // cross-tenant exception, and it stops at receipts.
  if (!allowed && bucket === 'receipts') {
    const { data: reviewer } = await supabase
      .from('platform_reviewers')
      .select('user_id')
      .maybeSingle();
    allowed = Boolean(reviewer);
  }

  if (!allowed) return new Response('Not permitted', { status: 403 });

  return Response.redirect(await signDownload(key), 302);
}
