/**
 * Tenant routing and session refresh.
 *
 * Two jobs, both of which must happen on every request:
 *
 *   1. Work out which tenant this host belongs to and pass it downstream as a
 *      header. The app never reads the tenant from a cookie or a query string,
 *      because both are attacker-controlled; the host is not.
 *
 *   2. Refresh the Supabase session cookie. Server components cannot set
 *      cookies, so if this does not happen here, a token expires mid-session
 *      and the user is silently logged out on their next navigation.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const ROOT = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'nothingmissing.ng';

// Must stay in step with app.reserved_slugs. tests-reserved-parity.mjs checks it.
const RESERVED = new Set([
  'www','app','api','admin','cdn','static','assets','mail','smtp','ftp',
  'ns1','ns2','mx','dev','staging','test','demo','sandbox','l','s',
  'sign-in','signin','login','signup','register','logout','reset','invite',
  'onboarding','field','pricing','about','blog','docs','help','legal',
  'privacy','terms','contact','status','security',
  'support','billing','account','accounts','nothingmissing','official',
  'system','root','noreply','security-team',
]);

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)'],
};

export async function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  const path = url.pathname;

  // Field links stay on the apex with no redirect: a storekeeper on a cheap
  // phone in a warehouse should not pay a round trip to submit a count.
  //
  // /l/<token> is the short public URL; the page itself lives at
  // /field/<token>. A rewrite rather than a redirect, so the address bar keeps
  // the short form and the token never appears in a Location header.
  if (path.startsWith('/l/')) {
    const token = path.slice(3);
    const url = request.nextUrl.clone();
    url.pathname = `/field/${token}`;
    return NextResponse.rewrite(url);
  }

  const isApex = host === ROOT || host === `www.${ROOT}` || host.endsWith('.vercel.app') || host.startsWith('localhost');
  const sub = host.endsWith(`.${ROOT}`) ? host.slice(0, -(ROOT.length + 1)) : null;

  if (host === `www.${ROOT}`) {
    url.host = ROOT;
    return NextResponse.redirect(url, 308);
  }

  if (isApex || !sub) {
    // /zenith typed on the apex: send them to the subdomain rather than serve
    // the app from the wrong origin.
    const first = path.split('/')[1];
    if (first && !RESERVED.has(first) && /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(first)) {
      const rest = path.slice(first.length + 1) || '/';
      return NextResponse.redirect(new URL(`${rest}${url.search}`, `https://${first}.${ROOT}`), 307);
    }
    return withSession(request, NextResponse.next());
  }

  if (RESERVED.has(sub)) {
    return NextResponse.redirect(new URL(`${path}${url.search}`, `https://${ROOT}`), 307);
  }

  // A real tenant host. Pass it on; the database decides whether it exists.
  const res = NextResponse.next({ request: { headers: new Headers(request.headers) } });
  res.headers.set('x-tenant-host', host);
  return withSession(request, res, host);
}

/** Refreshes the auth cookie onto the outgoing response. */
async function withSession(request: NextRequest, response: NextResponse, tenantHost?: string) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        // @supabase/ssr 0.7 takes the whole cookie jar at once rather than
        // named accessors. Writing to both request and response matters: the
        // request copy is what a server component reads later in this same
        // pass, the response copy is what the browser keeps.
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value));
          cookies.forEach(({ name, value, options }) =>
            response.cookies.set({ name, value, ...options })
          );
        },
      },
    }
  );

  // Touching getUser() is what triggers the refresh. The result is unused here
  // on purpose: authorisation happens in the page, against RLS.
  await supabase.auth.getUser();

  if (tenantHost) response.headers.set('x-tenant-host', tenantHost);
  return response;
}
