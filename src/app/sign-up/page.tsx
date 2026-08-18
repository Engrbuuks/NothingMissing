'use client';

import { Wordmark } from '@/components/Mark';

import { useState } from 'react';
import { browser } from '@/lib/supabase';

export default function SignUp() {
  const supabase = browser();
  // Somebody arriving from an invitation is not founding a company, and the
  // page said nothing about that — so they reasonably assumed sign-up meant
  // registering a new business.

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
        // Must go through the callback: Supabase sends a code that has to be
        // exchanged for a session before any page requiring one will work.
        //
        // No query string. Supabase validates this against an allow-list, and
        // a URL carrying `?next=…` has to match an entry that accounts for the
        // query — one more thing to get wrong in a dashboard nobody looks at.
        // The callback already defaults to /onboarding, so the parameter was
        // buying nothing.
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      // Only genuine input problems are shown. Anything else — including a
      // server error, which Supabase returns when the address already has a
      // confirmed account — falls through to the same confirmation screen a
      // new address gets.
      //
      // That is deliberate twice over: it keeps the promise this page makes
      // about not revealing who has an account, and it stops a Supabase-side
      // failure reaching somebody as a raw error they cannot act on. A person
      // who already has an account will find the sign-in link on the next
      // screen, which is where they needed to go anyway.
      const inputProblem =
        /password|email address|invalid|weak|characters/i.test(error.message) &&
        !/already|registered|exists/i.test(error.message);

      if (inputProblem) {
        setError(error.message);
        setBusy(false);
        return;
      }
    }

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
          <p style={{ color: 'var(--text-3)', fontSize: 12.5, marginTop: 12, lineHeight: 1.6 }}>
            If this address already has an account, no new email is sent —{' '}
            <a href="/sign-in" style={{ textDecoration: 'underline' }}>sign in</a> instead, or{' '}
            <a href="/auth/reset" style={{ textDecoration: 'underline' }}>set a new password</a>.
          </p>
          <a className="btn btn-p" href="/sign-in" style={{ marginTop: 22 }}>Go to sign in</a>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 400 }}>
        <Wordmark size={24} tagline />
        <h1 style={{ fontSize: 25 }}>Start a company</h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 7, lineHeight: 1.6 }}>
          This creates a new company with you as its owner. Free while you set it up, no card.
        </p>

        {/* Said plainly, because somebody arriving here from an invitation
            would otherwise create an empty company of their own and wonder
            why the register was blank. */}
        <div className="notice" style={{ marginTop: 18 }}>
          <p>
            <b>Been invited to join a company?</b> Do not sign up here — open the link in
            your invitation email instead, or{' '}
            <a href="/sign-in" style={{ textDecoration: 'underline' }}>sign in</a> if you
            already have an account.
          </p>
        </div>

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
