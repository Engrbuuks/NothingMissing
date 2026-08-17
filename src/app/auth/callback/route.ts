import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { server } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

/**
 * The auth callback. Everything Supabase emails points here.
 *
 * This was missing, and its absence broke sign-up entirely: confirmation links
 * pointed straight at /onboarding, which requires a session. Supabase sends a
 * one-time CODE in the URL that has to be exchanged for a session first — so
 * the link landed on a page that immediately bounced the person back to
 * sign-in, with no explanation and no way through.
 *
 * Handles three flows, because they arrive at the same place:
 *   * email confirmation after sign-up  → onboarding, or their company
 *   * a password reset link             → set a new password
 *   * an invitation accepted by email   → the join page
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/onboarding';
  // Supabase appends this itself on a recovery link. We never set it, because
  // a redirect_to carrying a query string has to match an allow-list entry
  // that accounts for the query — a needless way to fail.
  const type = url.searchParams.get('type');

  // Supabase reports its own failures here — an expired link, mostly. Say so
  // plainly rather than showing a broken page.
  const errorDescription = url.searchParams.get('error_description');
  if (errorDescription) {
    return NextResponse.redirect(
      new URL(`/sign-in?error=${encodeURIComponent(errorDescription)}`, url.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL('/sign-in?error=' + encodeURIComponent(
        'That link is missing its confirmation code. Open it directly from the email rather than copying it.'
      ), url.origin)
    );
  }

  const supabase = server(cookies());
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL('/sign-in?error=' + encodeURIComponent(
        'That link has expired or was already used. Ask for a new one.'
      ), url.origin)
    );
  }

  // A recovery link must land on the page that sets a new password, whatever
  // `next` says — otherwise somebody arrives signed in, having never chosen a
  // password, and the reset silently does nothing.
  if (type === 'recovery') {
    return NextResponse.redirect(new URL('/auth/update-password', url.origin));
  }

  // Somebody who already belongs to a company should go there, not to
  // onboarding, which would invite them to create a second one.
  const { data: membership } = await supabase
    .from('memberships')
    .select('companies ( slug )')
    .limit(1)
    .maybeSingle();

  const slug = (membership as any)?.companies?.slug;
  if (slug && next === '/onboarding') {
    const root = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';
    return NextResponse.redirect(`https://${slug}.${root}/`);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
