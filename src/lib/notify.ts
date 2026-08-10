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

  if (m.channel !== 'email' || !process.env.RESEND_API_KEY) return;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [m.recipient],
        subject: m.subject,
        html: wrap(m.subject, m.body),
      }),
    });

    await supabase
      .from('notifications')
      .update(
        res.ok
          ? { status: 'sent', sent_at: new Date().toISOString() }
          : { status: 'failed', error: `HTTP ${res.status}`, attempts: 1 }
      )
      .eq('id', row.id);
  } catch (e) {
    await supabase
      .from('notifications')
      .update({ status: 'failed', error: String(e).slice(0, 300), attempts: 1 })
      .eq('id', row.id);
  }
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
