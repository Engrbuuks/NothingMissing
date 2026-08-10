import { reportError } from '@/lib/report-error';

export async function POST(request: Request) {
  try {
    const b = await request.json();
    reportError(new Error(String(b.message ?? 'client error')), {
      digest: b.digest, route: b.route,
    });
  } catch {
    /* a malformed report is not worth an error of its own */
  }
  return new Response(null, { status: 204 });
}
