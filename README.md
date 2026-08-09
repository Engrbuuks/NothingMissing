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
    src/app/catalog          category → type → brand → model → units owned
    src/app/inventory        stock ledger: receive, issue, move between sites
    src/app/transfers        create, approve, dispatch, receive
    src/app/requests         approval chains
    src/app/submissions      field inbox and the review that posts to the register
    src/app/field/[token]    the public page a link holder opens — no account
    src/app/people           accounts, and the people who hold a link instead
    src/app/locations        sites, including the virtual warehouse
    src/app/audit            the append-only log
    src/lib/actions.ts       server actions — each calls a database function
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

## Movement

Transfers are the spine, and the code follows one rule: **every write goes
through a database function, not through INSERTs from JavaScript.**

`app.accept_transfer()` moves every line, opens a discrepancy for each flagged
one, stamps the waybill and writes the audit rows in a single transaction.
Doing that work from a server action would mean a dropped connection halfway
through leaves assets belonging to no register at all, with nothing to say
which ones.

The actions in `src/lib/actions.ts` also do no authorisation. The functions are
SECURITY DEFINER and check it themselves — only someone whose membership covers
the destination may accept a delivery. A check in the action would be a second
opinion that could drift from the first.

Verified against a live database:

    dispatch          4 assets leave the origin register, waybill issued
    origin accepts    refused: only the destination may confirm
    accept, 1 flagged 3 land at the destination, 1 held in transit
    result            discrepancy opened, waybill stays open

## The field loop

The part nobody else has, and the reason the rest exists.

A storekeeper who counts drums twice a month will never remember a password,
and you will never pay a seat for them — so the count never gets entered and
the register drifts. A link is a URL in a WhatsApp message instead.

`/field/[token]` is unauthenticated by design. Everything it can do is bounded
by `app.submit_from_link()`: the token is checked, the verbs granted are
checked, the location is checked, and what it writes is a **pending row**, never
a change. The blast radius of a stolen link is "somebody submitted a wrong
count", not "somebody moved our generators".

The count page deliberately does not show the system figure. If it did, the
counter would agree with it and the count would be worthless. The comparison
happens only on the reviewer's screen.

Verified against a live database:

    submit (no account)   comes back pending
    read the register     permission denied at the privilege level
    before review         register unchanged
    after review          3,850 written as a count_adjust movement
    side effect           the holder's accuracy record incremented itself

That last line is the thing worth having. It exists only as a by-product of
reviewing each submission, and it tells you whose figures to spot-check.

## What is built

| Route | What it does |
|---|---|
| `/assets` | the register, RLS-scoped, costs gated by role |
| `/catalog` | category → type → brand → model → units owned |
| `/inventory` | stock ledger, balances per location, issue and transfer |
| `/transfers` | create, approve, dispatch, receive with per-line flagging |
| `/requests` | approval chains matched from policy rows |
| `/submissions` | the field inbox: review a count against the book figure |
| `/l/<token>` | the public field page — no account, no session |
| `/locations` | sites, including the virtual warehouse |
| `/people` | memberships and location scope |
| `/audit` | the append-only log |
| `/diagnostics` | what this session can actually reach |

Verified against a live database:

    field link      a person with no account submits a count of 3910
    before review   the register still reads 4000 — nothing changed
    after accepting 3910 written as a count_adjust movement of exactly -90
    requests        an 8-asset transfer matched the two-step policy: manager then admin
    anon access     permission denied on assets, stock, companies, submissions, links

## Status

Every screen is built and reading live data: assets, catalog, inventory,
transfers, requests, field inbox, people and links, locations, audit log,
diagnostics.

Not built: bulk import, reports, tags and scanning, disposal and maintenance
screens. All exist in the database already — they need pages, not migrations.
