'use client';

import { Wordmark } from '@/components/Mark';

import { useState } from 'react';
import { browser } from '@/lib/supabase';

export default function SignUp() {
  const supabase = browser();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters. Length beats complexity.');
      return;
    }
    setBusy(true); setError(null);

    const { error } = await supabase.auth.signUp({
      email, password,
      options: {
        data: { full_name: name },
        emailRedirectTo: `${window.location.origin}/onboarding`,
      },
    });

    if (error) { setError(error.message); setBusy(false); return; }
    // Deliberately the same screen whether or not the address was already
    // registered: otherwise this page tells anyone who asks which of their
    // guesses has an account here.
    setSent(true); setBusy(false);
  }

  if (sent) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 400 }}>
          <h1 style={{ fontSize: 24 }}>Check your inbox</h1>
          <p style={{ color: 'var(--text-2)', marginTop: 14, lineHeight: 1.65 }}>
            We have sent a confirmation link to <b>{email}</b>. Open it and you will land
            back here to name your company.
          </p>
          <p style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 16, lineHeight: 1.6 }}>
            A company cannot be created until the address is confirmed — otherwise anyone
            could claim an address using an inbox they do not control.
          </p>
          <a className="btn btn-g" href="/sign-in" style={{ marginTop: 22 }}>Back to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <Wordmark size={24} tagline />
        <h1 style={{ fontSize: 25 }}>Create an account</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7 }}>
          Free while you set it up. No card.
        </p>

        <form onSubmit={submit} style={{ marginTop: 22 }}>
          <label className="lbl" htmlFor="name">Your name</label>
          <input className="inp" id="name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />

          <div style={{ height: 14 }} />
          <label className="lbl" htmlFor="email">Work email</label>
          <input className="inp" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />

          <div style={{ height: 14 }} />
          <label className="lbl" htmlFor="password">Password</label>
          <input className="inp" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" minLength={10} />
          <div className="hint">At least 10 characters. A long phrase beats a short tangle of symbols.</div>

          {error && <div className="notice bad" style={{ marginTop: 16, marginBottom: 0 }}><p>{error}</p></div>}

          <div style={{ height: 20 }} />
          <button className="btn btn-p btn-lg" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create my account'}
          </button>
        </form>

        <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 20, lineHeight: 1.6 }}>
          Already have one? <a href="/sign-in" style={{ textDecoration: 'underline' }}>Sign in</a>.
          Invited by a colleague? Open the link they sent — it takes you straight in.
        </p>
      </div>
    </main>
  );
}
