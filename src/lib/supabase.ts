/**
 * Supabase clients.
 *
 * Three of them, because the session lives in a cookie and each context reads
 * and writes cookies differently. Using the wrong one is the usual cause of
 * "I am logged in but the server thinks I am not".
 *
 *   browser()      client components
 *   server()       server components, route handlers, server actions
 *   middleware()   middleware only — it must also write refreshed cookies
 *
 * All three use the anon key. Every query they make is subject to row-level
 * security, so the database decides what comes back, not this code. There is
 * deliberately no service-role client anywhere in this app: if one is ever
 * needed it belongs in a server-only route with its own review.
 */
import { createBrowserClient, createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!URL || !KEY) {
  // Fail loudly at boot rather than with a confusing 401 on the first query.
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
      'Copy .env.local.example to .env.local and fill them in.'
  );
}

export function browser() {
  return createBrowserClient(URL, KEY);
}

type CookieStore = {
  getAll: () => { name: string; value: string }[];
  set?: (args: { name: string; value: string } & CookieOptions) => void;
};

/** For server components and route handlers. Pass `cookies()` from next/headers. */
export function server(cookieStore: CookieStore) {
  return createServerClient(URL, KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        // A server component cannot set cookies, and that is fine: the
        // middleware has already refreshed the session on this request, so
        // the token a component reads is never stale. Swallow rather than
        // throw, or every page render becomes a crash.
        try {
          list.forEach(({ name, value, options }) =>
            cookieStore.set?.({ name, value, ...options })
          );
        } catch {
          /* read-only context — expected in server components */
        }
      },
    },
  });
}
