# Authentication — Supabase setup

The code is wired. Three settings in the Supabase dashboard have to match it,
and a mismatch here is invisible until somebody tries to sign up.

## 1. Redirect URLs

**Authentication → URL Configuration → Redirect URLs.** Add:

```
https://nothingmissing.ng/auth/callback
https://*.nothingmissing.ng/auth/callback
http://localhost:3000/auth/callback
```

Supabase refuses to redirect anywhere not on this list. Without the entry, the
confirmation email lands on an error page and nothing in your logs explains why.

**Site URL:** `https://nothingmissing.ng`

## 2. Email confirmation

**Authentication → Providers → Email → Confirm email: ON.**

`signup_company()` refuses to create a company for an unconfirmed address,
because otherwise anyone can claim a slug using an inbox they do not control.
With confirmation off, sign-ups get stuck between having an account and being
allowed to use it.

## 3. Email delivery

Supabase's built-in sender is rate-limited to a handful of messages an hour and
is fine for testing only. Before real customers, set SMTP under
**Authentication → Emails → SMTP Settings** — Resend works, and you already have
the key for notifications.

Without it, invitations to a busy company will silently stop arriving.

## What the flows do

**Sign-up** → confirmation email → `/auth/callback` exchanges the code for a
session → `/onboarding` to name the company. Somebody who already belongs to a
company goes there instead, rather than being invited to create a second one.

**Password reset** → `/auth/reset` → email → callback → `/auth/update-password`.
The callback sends recovery links there regardless of `next`, because otherwise
somebody arrives signed in having never chosen a password and the reset
silently does nothing.

**Invitation** → `/join/<token>` → sign in or create an account → accept.

## Testing it

Sign up with a real address you control. If the confirmation link lands on
sign-in with an error, the redirect URL in step 1 is wrong — that is the
failure this document exists for.
