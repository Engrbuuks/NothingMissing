'use client';

import { useState } from 'react';
import { browser } from '@/lib/supabase';
import { Wordmark } from '@/components/Mark';

/**
 * Asking for a password reset.
 *
 * This did not exist, which meant anyone who forgot their password was locked
 * out permanently with no route back except us editing the database.
 */
export default function Reset() {
  const supabase = browser();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);

    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?type=recovery`,
    });

    // Deliberately the same screen whether or not the address is registered.
    // Saying "no such account" turns this page into a way to find out who
    // banks with you.
    setSent(true);
    setBusy(false);
  }

  if (sent) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 400 }}>
          <h1 style={{ fontSize: 24 }}>Check your inbox</h1>
          <p style={{ color: 'var(--text-2)', marginTop: 14, lineHeight: 1.65 }}>
            If <b>{email}</b> has an account, a link to set a new password is on its way. It
            works once and expires in an hour.
          </p>
          <a className="btn btn-g" href="/sign-in" style={{ marginTop: 22 }}>Back to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ marginBottom: 22 }}><Wordmark size={22} /></div>
        <h1 style={{ fontSize: 25 }}>Forgotten your password</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7, lineHeight: 1.6 }}>
          We will email you a link to set a new one.
        </p>

        <form onSubmit={submit} style={{ marginTop: 22 }}>
          <label className="lbl" htmlFor="email">Your email</label>
          <input className="inp" id="email" type="email" required autoComplete="username"
                 value={email} onChange={(e) => setEmail(e.target.value)} />

          <div style={{ height: 20 }} />
          <button className="btn btn-p btn-lg" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'Send me a link'}
          </button>
        </form>

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 20 }}>
          <a href="/sign-in" style={{ textDecoration: 'underline' }}>Back to sign in</a>
        </p>
      </div>
    </main>
  );
}
