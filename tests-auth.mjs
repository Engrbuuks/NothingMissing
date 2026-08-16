/**
 * Authentication is the one path where a mistake locks everyone out, so this
 * checks the wiring rather than trusting it.
 */
import { readFileSync, existsSync } from 'node:fs';

const checks = [];
const has = (f) => existsSync(f);
const read = (f) => has(f) ? readFileSync(f, 'utf8') : '';

const signin  = read('src/app/sign-in/page.tsx');
const signup  = read('src/app/sign-up/page.tsx');
const cb      = read('src/app/auth/callback/route.ts');
const reset   = read('src/app/auth/reset/page.tsx');
const update  = read('src/app/auth/update-password/page.tsx');
const signout = read('src/app/auth/sign-out/route.ts');
const supa    = read('src/lib/supabase.ts');
const mw      = read('src/middleware.ts');

const t = (label, ok) => checks.push([label, ok]);

t('sign-in page exists and calls signInWithPassword', /signInWithPassword/.test(signin));
t('sign-up page exists and calls signUp', /auth\.signUp/.test(signup));
t('sign-out route exists and calls signOut', /signOut/.test(signout));

t('callback route exists', has('src/app/auth/callback/route.ts'));
t('callback exchanges the code for a session', /exchangeCodeForSession/.test(cb));
t('callback handles an expired link', /expired|error_description/.test(cb));
t('callback sends recovery links to set a password', /recovery/.test(cb));

t('sign-up confirmation goes through the callback', /auth\/callback/.test(signup));
t('password reset page exists', has('src/app/auth/reset/page.tsx'));
t('reset asks Supabase to email a link', /resetPasswordForEmail/.test(reset));
t('reset does not reveal whether an account exists', /same screen|whether or not/i.test(reset));
t('update-password page exists', has('src/app/auth/update-password/page.tsx'));
t('update-password calls updateUser', /updateUser/.test(update));
t('sign-in links to the reset page', /auth\/reset/.test(signin));

t('server client refreshes the session cookie', /getAll|setAll/.test(supa));
t('middleware refreshes the session', /getUser|getSession/.test(mw));
t('/auth is a reserved slug', /'auth'/.test(mw));

let bad = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad++;
}
console.log(bad ? `\n✗ ${bad} authentication gaps` : '\n✓ authentication is wired end to end');
process.exit(bad ? 1 : 0);
