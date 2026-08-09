# Nothing Missing

**nothingmissing.ng**

Asset and inventory management for companies running depots, branches and site
offices. Approval chains, branded waybills, field submissions from people who
have no account, and an audit trail nobody can edit — including you.

---

## Deploying

The Next.js app is at the **repository root**. There is no `vercel.json` and no
root-directory setting to configure: Vercel detects Next.js from `package.json`
and everything follows. That is deliberate — a stray `vercel.json` left over
from static hosting is what makes builds fail with "output directory not found".

On Vercel, set three environment variables and nothing else:

    NEXT_PUBLIC_SUPABASE_URL       https://your-project.supabase.co
    NEXT_PUBLIC_SUPABASE_ANON_KEY  your anon key
    NEXT_PUBLIC_ROOT_DOMAIN        nothingmissing.ng

Leave every Build & Development Setting on its default. If any Override toggle
is on, turn it off.

The anon key belongs in a browser: it identifies the project, not a person, and
every table is protected by row-level security. The **service role key must
never appear here** — it bypasses RLS entirely.

## Running locally

    cp .env.local.example .env.local     # fill in your anon key
    npm install
    npm run dev

`localhost` is treated as the apex, so you get the welcome page. To exercise a
tenant, add to your hosts file:

    127.0.0.1  eppme.localhost

then open `http://eppme.localhost:3000`.

## Layout

    src/middleware.ts        tenant routing + session refresh, every request
    src/lib/supabase.ts      the clients: browser and server
    src/lib/session.ts       who is signed in, which tenant, what they may do
    src/components/Shell.tsx sidebar, top bar, per-tenant brand colour
    src/app/sign-in          real Supabase password auth
    src/app/assets           the register, reading live rows
    src/app/diagnostics      checks the wiring and reports what this session reaches

    backend/                 10 Postgres migrations, 271 tests, bootstrap.sql
    public/prototype/        the original clickable prototype, kept as the spec

The prototype stays reachable at `/prototype/app.html`. It is a specification,
not a fallback — every screen there is what the built app is working towards.

## Two rules the code follows

**The tenant comes from the host.** Never from a cookie, a query string or a
header the client could set. `middleware.ts` reads it from `Host` and passes it
down as `x-tenant-host`; nothing else is trusted.

**Filtering is the database's job.** The asset query carries no `company_id`
and no location filter — row-level security applies both. Adding them in the
client would hide a mistake, and if RLS were ever wrong we want to see it
rather than paper over it. The permission helpers in `session.ts` exist only to
hide UI a person cannot use; they enforce nothing.

## The database

    cd backend
    bash scripts/test.sh

Drops the database, replays all ten migrations from empty, seeds two unrelated
companies and runs 271 assertions. See `backend/README.md` for the design
decisions — membership-based tenancy, USING paired with WITH CHECK on every
write policy, purchase cost behind its own table, an append-only audit log, and
the atomic transfer acceptance.

To set up a real project: run migrations `0001` through `0010` in order in the
Supabase SQL editor, then `bootstrap.sql` once. Do **not** run
`supabase/seed.sql` — those are test fixtures for two fictional companies.

## Status

Built: the full prototype, all ten migrations, and the application spine —
auth, tenant resolution, the shell, the asset register, diagnostics.

Next: transfers end to end, then the field submission inbox. Once one movement
flow works against live data the rest is repetition.
