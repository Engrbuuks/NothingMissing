import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack.
 *
 * Two things here are easy to get wrong and expensive to get wrong quietly.
 *
 * 1. The signature is HMAC-SHA512, not the SHA-256 most providers use, and it
 *    is computed over the RAW request body. Re-serialising the parsed JSON and
 *    hashing that works right up until a key order or a unicode escape differs,
 *    at which point valid payments start being rejected for no visible reason.
 *
 * 2. Paystack retries a failed delivery every three minutes for four attempts
 *    and then hourly for 72 hours. The same event will arrive more than once,
 *    so the handler has to be idempotent — which is why every event is recorded
 *    by its Paystack id before anything is acted on.
 */

const SECRET = process.env.PAYSTACK_SECRET_KEY;
const API = 'https://api.paystack.co';

export const paystackConfigured = () => Boolean(SECRET);

/**
 * Constant-time comparison. A normal string compare leaks how many leading
 * characters matched through its timing, which over enough attempts is enough
 * to forge a signature one byte at a time.
 */
export function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!SECRET || !signature) return false;

  const expected = createHmac('sha512', SECRET).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type InitResult =
  | { ok: true; authorization_url: string; access_code: string; reference: string }
  | { ok: false; error: string };

/**
 * Starts a transaction. The amount comes from the database, never from the
 * browser — a client-supplied amount is a client-supplied discount.
 */
export async function initializeTransaction(params: {
  email: string;
  amountMinor: number;
  reference: string;
  companyId: string;
  callbackUrl: string;
}): Promise<InitResult> {
  if (!SECRET) return { ok: false, error: 'Payments are not configured yet.' };

  try {
    const res = await fetch(`${API}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amountMinor,          // kobo
        currency: 'NGN',
        reference: params.reference,
        callback_url: params.callbackUrl,
        // Carried back on the webhook, so an event can be tied to a company
        // without trusting anything in the redirect.
        metadata: { company_id: params.companyId },
        channels: ['card', 'bank', 'ussd', 'bank_transfer'],
      }),
    });

    const body = await res.json();
    if (!res.ok || !body?.status) {
      return { ok: false, error: body?.message ?? `Paystack returned ${res.status}` };
    }
    return {
      ok: true,
      authorization_url: body.data.authorization_url,
      access_code: body.data.access_code,
      reference: body.data.reference,
    };
  } catch (e) {
    return { ok: false, error: `Could not reach Paystack: ${String(e).slice(0, 120)}` };
  }
}

/**
 * A second check against Paystack's own record before crediting anything.
 * The webhook is signed, but verifying independently costs one request and
 * removes a whole class of "what if the signature scheme changes" worry.
 */
export async function verifyTransaction(reference: string) {
  if (!SECRET) return null;
  try {
    const res = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await res.json();
    return res.ok && body?.status ? body.data : null;
  } catch {
    return null;
  }
}
