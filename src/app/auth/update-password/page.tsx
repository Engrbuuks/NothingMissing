'use client';

import { useState } from 'react';
import { browser } from '@/lib/supabase';
import { Wordmark } from '@/components/Mark';

/**
 * Setting a new password, reached from a recovery link.
 *
 * The callback has already exchanged the code for a session by the time
 * somebody lands here, so this is a plain update — but the session is
 * recovery-scoped, and the person has still not chosen a password. Sending
 * them anywhere else first would leave the reset half-finished.
 */
export default function UpdatePassword() {
  const supabase = browser();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters. A long phrase beats a short tangle of symbols.');
      return;
    }
    if (password !== confirm) {
      setError('Those do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(
        /session/i.test(error.message)
          ? 'That link has expired. Ask for a new one from the sign-in page.'
          : error.message
      );
      setBusy(false);
      return;
    }
    window.location.href = '/';
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ marginBottom: 22 }}><Wordmark size={22} /></div>
        <h1 style={{ fontSize: 25 }}>Choose a new password</h1>

        <form onSubmit={submit} style={{ marginTop: 22 }}>
          <label className="lbl" htmlFor="pw">New password</label>
          <input className="inp" id="pw" type="password" required minLength={10}
                 autoComplete="new-password" value={password}
                 onChange={(e) => setPassword(e.target.value)} />
          <div className="hint">At least 10 characters.</div>

          <div style={{ height: 14 }} />
          <label className="lbl" htmlFor="pw2">Again</label>
          <input className="inp" id="pw2" type="password" required
                 autoComplete="new-password" value={confirm}
                 onChange={(e) => setConfirm(e.target.value)} />

          {error && <div className="notice bad" style={{ marginTop: 16, marginBottom: 0 }}><p>{error}</p></div>}

          <div style={{ height: 20 }} />
          <button className="btn btn-p btn-lg" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set my password'}
          </button>
        </form>
      </div>
    </main>
  );
}
