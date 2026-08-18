/**
 * Notifications.
 *
 * Every message is written to app.notifications first and delivered second.
 * That ordering matters: a queued row survives a failed API call, can be
 * retried, and leaves a record of what was sent to whom — which is the first
 * thing anyone asks for when somebody says they were never told about a
 * transfer.
 *
 * Email goes through Resend. If RESEND_API_KEY is absent the row simply stays
 * queued and the Notifications page shows it, so a missing key degrades to
 * "nothing sent" rather than a crash on an unrelated screen.
 *
 * WhatsApp and SMS are queued but not delivered — they need a Nigerian
 * provider account, and sending half-built messages to real phone numbers is
 * worse than sending none.
 */
import { cookies } from 'next/headers';
import { server } from './supabase';

export type Channel = 'email' | 'sms' | 'whatsapp';

export type Message = {
  companyId: string;
  event: string;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
};

const FROM = process.env.NOTIFY_FROM ?? 'Nothing Missing <no-reply@nothingmissing.ng>';

/** Queue and attempt delivery. Never throws — a failed notification must not
 *  roll back the movement that triggered it. */
export async function notify(m: Message): Promise<void> {
  const supabase = server(cookies());

  const { data: row } = await supabase
    .from('notifications')
    .insert({
      company_id: m.companyId,
      event: m.event,
      channel: m.channel,
      recipient: m.recipient,
      subject: m.subject,
      body: m.body,
      status: 'queued',
    })
    .select('id')
    .single();

  if (!row) return;

  const result =
    m.channel === 'email' ? await sendEmail(m) : await sendTermii(m);

  await supabase
    .from('notifications')
    .update(
      result.sent
        ? {
            status: 'sent',
            sent_at: new Date().toISOString(),
            provider: result.provider,
            provider_id: result.id ?? null,
          }
        : result.skipped
          ? { provider: result.provider }   // still queued, no key configured
          : { status: 'failed', error: result.error?.slice(0, 300), attempts: 1,
              provider: result.provider }
    )
    .eq('id', row.id);
}

type Sent =
  | { sent: true; provider: string; id?: string }
  | { sent: false; skipped: true; provider: string }
  | { sent: false; skipped?: false; provider: string; error: string };

async function sendEmail(m: Message): Promise<Sent> {
  if (!process.env.RESEND_API_KEY) return { sent: false, skipped: true, provider: 'resend' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM, to: [m.recipient], subject: m.subject, html: wrap(m.subject, m.body),
      }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok
      ? { sent: true, provider: 'resend', id: body?.id }
      : { sent: false, provider: 'resend', error: body?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, provider: 'resend', error: String(e) };
  }
}

/**
 * SMS and WhatsApp through Termii, which is the practical choice for Nigerian
 * numbers — international providers route poorly to MTN and Glo, and delivery
 * rates matter more than API elegance when the message is "your delivery is
 * three days overdue".
 *
 * Messages are truncated to 300 characters. An SMS beyond 160 is billed as
 * several, and a notification that costs four segments is a notification
 * somebody will eventually switch off.
 */
async function sendTermii(m: Message): Promise<Sent> {
  const key = process.env.TERMII_API_KEY;
  if (!key) return { sent: false, skipped: true, provider: 'termii' };

  const to = normaliseNigerianNumber(m.recipient);
  if (!to) return { sent: false, provider: 'termii', error: 'Not a usable phone number' };

  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        to,
        from: process.env.TERMII_SENDER_ID ?? 'NothingMissing',
        sms: `${m.subject}\n\n${m.body}`.slice(0, 300),
        type: 'plain',
        channel: m.channel === 'whatsapp' ? 'whatsapp' : 'generic',
      }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok && body?.message_id
      ? { sent: true, provider: 'termii', id: String(body.message_id) }
      : { sent: false, provider: 'termii', error: body?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { sent: false, provider: 'termii', error: String(e) };
  }
}

/**
 * Nigerian numbers arrive in every shape a person might type: 08031234567,
 * +2348031234567, 2348031234567, 803 123 4567. Termii wants 234 followed by
 * ten digits. Getting this wrong means messages that silently go nowhere.
 */
export function normaliseNigerianNumber(input: string): string | null {
  const d = (input ?? '').replace(/\D/g, '');
  if (/^234\d{10}$/.test(d)) return d;              // already international
  if (/^0\d{10}$/.test(d)) return '234' + d.slice(1); // 0803...
  if (/^\d{10}$/.test(d)) return '234' + d;          // 803... with no zero
  return null;
}

/** Who should hear about an event, honouring the company's preferences. */
export async function recipientsFor(companyId: string, event: string, roles: string[]) {
  const supabase = server(cookies());

  const { data: pref } = await supabase
    .from('notification_prefs')
    .select('email, sms, whatsapp, locked')
    .eq('event', event)
    .maybeSingle();

  // A locked event ignores the preference — discrepancy alerts are the safety
  // net on the register, and a company that silences them finds out about its
  // own losses months late.
  if (!pref?.email && !(pref as any)?.locked) return [];

  const { data: people } = await supabase
    .from('memberships')
    .select('role, profiles ( email, full_name )')
    .in('role', roles);

  return [...new Set((people ?? []).map((p: any) => p.profiles?.email).filter(Boolean))];
}

/** Plain, narrow, and readable in a preview pane. Nothing that needs images. */
function wrap(subject: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#F3F4FB;padding:28px 16px;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161F">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:520px;background:#fff;
      border-radius:16px;padding:28px" cellpadding="0" cellspacing="0">
      <tr><td style="font-size:13px;font-weight:700;color:#5B4BE8;letter-spacing:.04em;
        text-transform:uppercase;padding-bottom:14px">Nothing Missing</td></tr>
      <tr><td style="font-size:19px;font-weight:700;letter-spacing:-.02em;padding-bottom:12px">
        ${escapeHtml(subject)}</td></tr>
      <tr><td style="font-size:14.5px;line-height:1.62;color:#5F6379">
        ${escapeHtml(body).replace(/\n/g, '<br>')}</td></tr>
      <tr><td style="padding-top:22px;font-size:11.5px;color:#9296AC;line-height:1.5">
        Sent because of an event in your company's register. Change what you receive in
        Settings → Notifications.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)
  );

/**
 * Announce an event to whoever should hear about it.
 *
 * Twelve events had a preference row and a settings toggle from the start, and
 * `notify()` was never called for any of them — so a company could turn a
 * notification on, see it listed, and never receive one. The toggle described
 * something that did not happen.
 *
 * Deliberately never throws. A transfer that dispatched successfully must not
 * appear to fail because an email provider was slow, and a notification is
 * always recoverable from the queue.
 */
export async function announce(params: {
  companyId: string;
  event: string;
  subject: string;
  body: string;
  roles?: string[];
}): Promise<void> {
  try {
    const roles = params.roles ?? ['owner', 'admin', 'manager'];
    const to = await recipientsFor(params.companyId, params.event, roles);

    // No recipients is a normal outcome — the company turned it off, or
    // nobody holds a role that should hear about it.
    for (const recipient of to) {
      await notify({
        companyId: params.companyId,
        event: params.event,
        channel: 'email',
        recipient,
        subject: params.subject,
        body: params.body,
      });
    }
  } catch {
    /* never let telling somebody break the thing that happened */
  }
}
