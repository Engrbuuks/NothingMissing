'use client';

import { Wordmark } from '@/components/Mark';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { browser } from '@/lib/supabase';

export default function SignIn() {
  const router = useRouter();
  const supabase = browser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // Deliberately vague. "No account with that email" tells anyone who asks
      // which addresses are registered here, one guess at a time.
      setError(
        error.message.toLowerCase().includes('invalid')
          ? 'That email and password do not match.'
          : error.message
      );
      setBusy(false);
      return;
    }

    // A full reload rather than a client transition: the session cookie was
    // just written, and the server needs to see it on the next request.
    window.location.href = '/';
  }

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <Wordmark size={24} tagline />
        <h1 style={{ fontSize: 25 }}>Sign in</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7 }}>
          Pick up where your register left off.
        </p>

        <form onSubmit={submit} style={{ marginTop: 22 }}>
          <label className="lbl" htmlFor="email">
            Work email
          </label>
          <input
            id="email"
            className="inp"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <div style={{ height: 16 }} />

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <label className="lbl" htmlFor="password">
              Password
            </label>
            <a href="/auth/reset"
               style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--brand)' }}>
              Forgotten it?
            </a>
          </div>
          <input
            id="password"
            className="inp"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <div className="notice bad" style={{ marginTop: 16, marginBottom: 0 }}>
              <p>{error}</p>
            </div>
          )}

          <div style={{ height: 20 }} />
          <button className="btn btn-p btn-lg" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 20, lineHeight: 1.6 }}>
          Accounts are created by your company owner, not self-served. If you do not have
          one, ask them to invite you.
        </p>
      </div>
    </main>
  );
}
