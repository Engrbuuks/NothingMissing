/**
 * Error reporting.
 *
 * Deliberately provider-agnostic and tiny. Sentry is a fine choice and this is
 * shaped to be swapped for it in one function, but a hosted error tracker is
 * another account, another key and another data-processing agreement — and
 * until there are customers, a structured line in the Vercel log answers the
 * same question.
 *
 * What matters more than the destination is that every report carries the
 * digest the user was shown, so a person saying "it said reference a7f3c2" can
 * be matched to a specific failure rather than a time range.
 */
type Context = {
  digest?: string;
  route?: string;
  companyId?: string;
  userId?: string;
};

export function reportError(error: unknown, ctx: Context = {}) {
  const payload = {
    at: new Date().toISOString(),
    level: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    ...ctx,
  };

  // Structured so a log search can filter on it, rather than a bare string.
  console.error(JSON.stringify(payload));

  // With SENTRY_DSN set this becomes a single call. Left as one place to
  // change rather than scattered through the app.
  if (process.env.SENTRY_DSN) {
    fetch(process.env.SENTRY_DSN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      /* reporting a failure must never itself fail loudly */
    });
  }
}
