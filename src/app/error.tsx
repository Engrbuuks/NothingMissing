'use client';

import { useEffect } from 'react';

/**
 * What a person sees when something breaks.
 *
 * Two rules: say what happened in language they can act on, and never show the
 * raw error to someone who cannot use it. A stack trace helps nobody standing
 * in a warehouse, and database messages sometimes carry table names we would
 * rather not advertise.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Once error tracking is wired, this is where it goes. Until then the
    // digest is what ties a report to a server log.
    console.error(error);
  }, [error]);

  const isPermission = /permission denied|row-level security|42501/i.test(error.message);
  const isSchema = /schema cache|does not exist|relation/i.test(error.message);

  return (
    <main style={{ maxWidth: 560, margin: '0 auto', padding: '80px 24px' }}>
      <h1 style={{ fontSize: 24 }}>
        {isPermission
          ? 'You do not have access to that'
          : isSchema
            ? 'Something is not set up yet'
            : 'Something went wrong'}
      </h1>

      <p style={{ color: 'var(--text-2)', marginTop: 14, lineHeight: 1.65 }}>
        {isPermission
          ? 'Your role covers some locations and not others, and this is one of the others. If you should have access, ask an owner or admin to widen it.'
          : isSchema
            ? 'Part of the database this page needs has not been created. If you are setting this up, check the migrations have all been applied.'
            : 'This is our fault, not yours. Trying again often works — the underlying data has not been changed.'}
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
        <button className="btn btn-p" onClick={reset}>Try again</button>
        <a className="btn btn-g" href="/assets">Back to the register</a>
        {isSchema && <a className="btn btn-g" href="/diagnostics">Open diagnostics</a>}
      </div>

      {error.digest && (
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 26, fontFamily: 'var(--mono)' }}>
          Reference {error.digest} — quote this if you report it.
        </p>
      )}
    </main>
  );
}
