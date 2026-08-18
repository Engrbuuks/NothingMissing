import { createClient } from '@supabase/supabase-js';

/**
 * The service-role client.
 *
 * This key bypasses row-level security completely — it is the one credential
 * that can read and write every company's data. So it lives here, behind two
 * functions, rather than being imported freely:
 *
 *   * `adminAuth()` is for creating and inviting auth users, which the anon
 *     key genuinely cannot do.
 *   * `adminConfigured()` lets callers degrade gracefully instead of throwing
 *     a stack trace at somebody who was trying to invite a colleague.
 *
 * Never import this into a page or a client component. Server actions and
 * route handlers only, and only for work the anon key cannot do.
 */
export const adminConfigured = () =>
  Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

export function adminAuth() {
  if (!adminConfigured()) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  }
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
