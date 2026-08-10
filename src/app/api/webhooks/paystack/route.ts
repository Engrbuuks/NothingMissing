import { createClient } from '@supabase/supabase-js';
import { verifySignature, verifyTransaction } from '@/lib/paystack';
import { reportError } from '@/lib/report-error';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';   // needs node:crypto

/**
 * The Paystack webhook.
 *
 * This is the authoritative signal that a payment happened, not the browser
 * redirect — a customer whose network drops after paying still gets what they
 * paid for, because the truth arrives server to server.
 *
 * It uses the service role key, and this is the one place in the application
 * that does. There is no user session here: the caller is Paystack, and the
 * proof of identity is the signature verified below. Everything it can do is
 * bounded by the three functions it calls.
 */
const admin = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: 'app' }, auth: { persistSession: false } }
  );

export async function POST(request: Request) {
  // The raw body, read before anything parses it. Hashing a re-serialised
  // object works until a key order differs, and then valid payments start
  // being rejected for no visible reason.
  const raw = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  if (!verifySignature(raw, signature)) {
    // Deliberately terse. An attacker learns nothing about why.
    return new Response('Invalid signature', { status: 401 });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    reportError(new Error('Paystack webhook received but SUPABASE_SERVICE_ROLE_KEY is not set'));
    // 200 anyway: Paystack would otherwise retry for 72 hours against an
    // endpoint that cannot succeed until a key is added.
    return new Response(null, { status: 200 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('Malformed', { status: 400 });
  }

  const supabase = admin();
  const externalId = String(event?.data?.id ?? event?.data?.reference ?? '');
  const companyId = event?.data?.metadata?.company_id ?? null;

  // Idempotency, before anything is acted on. Paystack retries every three
  // minutes then hourly for 72 hours, so this event will arrive again; the
  // unique index makes the second insert fail and the handler stop.
  const { error: dupe } = await supabase.from('webhook_events').insert({
    provider: 'paystack',
    external_id: externalId || crypto.randomUUID(),
    event: String(event?.event ?? 'unknown'),
    company_id: companyId,
    payload: event,
  });

  if (dupe) {
    // Already seen. 200 so Paystack stops retrying.
    return new Response(null, { status: 200 });
  }

  try {
    switch (event.event) {
      case 'charge.success': {
        // Verified independently against Paystack's own record rather than
        // trusting the payload alone. One extra request, one fewer class of
        // worry.
        const confirmed = await verifyTransaction(event.data.reference);
        const amount = confirmed?.amount ?? event.data.amount;

        if (confirmed && confirmed.status !== 'success') break;

        await supabase.rpc('apply_payment', {
          p_reference: event.data.reference,
          p_paystack_id: String(event.data.id),
          p_amount_minor: amount,
          p_channel: event.data.channel ?? null,
          p_paid_at: event.data.paid_at ?? null,
        });
        break;
      }

      case 'subscription.create':
      case 'subscription.enable':
        await supabase.rpc('mark_subscription', {
          p_customer_code: event.data?.customer?.customer_code,
          p_status: 'active',
          p_period_end: event.data?.next_payment_date?.slice(0, 10) ?? null,
        });
        break;

      case 'invoice.payment_failed':
        await supabase.rpc('mark_subscription', {
          p_customer_code: event.data?.customer?.customer_code,
          p_status: 'past_due',
        });
        break;

      case 'subscription.disable':
      case 'subscription.not_renew':
        await supabase.rpc('mark_subscription', {
          p_customer_code: event.data?.customer?.customer_code,
          p_status: 'cancelled',
        });
        break;

      default:
        // Recorded above, deliberately not acted on. Paystack sends a lot of
        // events and reacting to ones we do not understand is how a
        // subscription gets cancelled by surprise.
        break;
    }

    await supabase
      .from('webhook_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('provider', 'paystack')
      .eq('external_id', externalId);
  } catch (e) {
    reportError(e, { route: 'paystack-webhook' });
    await supabase
      .from('webhook_events')
      .update({ error: String(e).slice(0, 400) })
      .eq('provider', 'paystack')
      .eq('external_id', externalId);
    // Still 200: the event is stored, and a 72-hour retry storm helps nobody.
    // The unprocessed row is the thing to alert on.
  }

  return new Response(null, { status: 200 });
}
