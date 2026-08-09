/**
 * Notifications.
 *
 * Deliberately not wired to a provider yet, and this file is where that
 * decision lives rather than being spread through the app.
 *
 * Everything that would be sent is written to app.notifications first. That is
 * the right shape regardless of provider: a queued row survives a failed API
 * call, can be retried, and gives you a record of what was sent to whom — which
 * matters when someone says they were never told about a transfer.
 *
 * To actually send, fill in `deliver()`. Resend for email is a few lines;
 * WhatsApp and SMS need an account with a Nigerian provider. Until then rows
 * accumulate with status 'queued' and the Notifications page shows them, so you
 * can see exactly what the system would have sent.
 */
import { cookies } from 'next/headers';
import { server } from './supabase';

export type Channel = 'email' | 'sms' | 'whatsapp';

export type Notification = {
  company_id: string;
  event: string;
  channel: Channel;
  recipient: string;
  subject: string;
  body: string;
};

export async function queue(n: Notification): Promise<void> {
  const supabase = server(cookies());
  await supabase.from('notifications').insert({ ...n, status: 'queued' });
}

/**
 * Where a provider would go. Left unimplemented on purpose: sending half-built
 * notifications to real people is worse than sending none, and a queued row
 * you can inspect is more useful than a fire-and-forget call you cannot.
 *
 * With Resend this becomes roughly:
 *
 *   await fetch('https://api.resend.com/emails', {
 *     method: 'POST',
 *     headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
 *     body: JSON.stringify({ from, to, subject, html }),
 *   });
 *
 * and the row moves from 'queued' to 'sent' or 'failed' with the error kept.
 */
export async function deliver(_id: string): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: 'No provider configured' };
}
