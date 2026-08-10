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

To set up a real project: run migrations `0001` through `0011` in order in the
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

## A bug worth recording

`issue_location_link()` originally returned `/l/<slug>#<token>`. Putting the
token in a fragment keeps it out of server logs, proxy logs and Referer
headers — a good instinct, and wrong here. A fragment is never sent to the
server, so a server-rendered page receives the slug and no token, and every
link resolved to nothing. The user saw "this link is no longer valid".

Migration `0011` moves the token into the path. What makes that acceptable is
that the token is not a session: it grants no read access to anything, and
everything it can do lands as a pending row a manager reviews. A leaked link
means somebody submitted a wrong count, not that somebody moved your
generators.

## Build B — lifecycle, procurement and reporting

| Route | What it does |
|---|---|
| `/import` | paste a spreadsheet; the batch is all or nothing |
| `/maintenance` | what is due, from the model's interval; return to service |
| `/purchase-orders` | ordering, and goods receipt with serial capture |
| `/suppliers` | lead time computed from your own orders, not from a promise |
| `/discrepancies` | assets belonging to neither register, with three exits |
| `/reports` | depreciation, book value, disposals and losses |

Verified against a live database:

    goods receipt   3 units with 2 serials — refused outright
                    3 units with 3 serials — 3 assets created
    lead time       9.0 days, computed from issue and receipt timestamps
    disposal        theft with no police reference — refused
                    sale with no proceeds — refused
                    sale below book value — NGN 292,000 loss recorded
    maintenance     scheduled from the catalog model, not per asset

The rules live in the database, not in the forms. `receive_goods()` refuses a
serialised line whose serial count does not match its quantity, because twelve
identical chairs with no serials are twelve rows that will drift from reality
within a year. `dispose_asset()` demands evidence per reason, because a theft
with no reference is exactly the pattern an audit flags.

## The last pieces

| Route | What it does |
|---|---|
| `/assets/[id]` | custody timeline, specification, handover, disposal |
| `/requests/new` | raise a repair or purchase; the chain picks itself |
| `/settings` | company profile, brand colour, your address |

Plus the three states a product is actually judged on, which were missing:

**`error.tsx`** distinguishes a permission failure from a schema failure from
everything else, and says something a person can act on. It never shows a raw
error: a stack trace helps nobody standing in a warehouse, and database
messages sometimes carry table names we would rather not advertise.

**`loading.tsx`** — with a few thousand assets the register will not paint
instantly, and a blank screen reads as broken rather than busy.

**First-run.** An empty register now offers to import a spreadsheet rather than
showing a bare table, because most registers start as one.

**Mobile navigation.** The sidebar was `display:none` under 860px, which left
no way to navigate at all on a phone. It is now a horizontal strip. Receiving
and the field page happen in a warehouse, so this was not a nicety.

Verified against a live database:

    requests     NGN 45,000 repair  → manager
                 NGN 1.45m repair   → admin then owner
    custody      a handover writes an audit row against the asset
    settings     an invalid brand colour is refused by the constraint
    locations    archiving a site holding 4 assets is refused, with the fix in the hint

## The dashboard

Built to the prototype rather than reinterpreted from it. Five bands: the dark
hero with its bloom, what needs you, your assets, movement volume, and what is
moving.

The charts are hand-drawn SVG in `src/lib/charts.ts` — a smoothed sparkline and
a segmented donut, each a few lines of path maths. No charting library: one
would add 40kb to every page load, impose its own visual language, and still
need overriding to match the design. They are pure functions returning strings,
so they render on the server with no client JavaScript.

Every figure is a live count scoped by row-level security. Nothing is cached,
so nothing can drift from the register. A brand new company gets a first-run
screen offering to import a spreadsheet rather than a wall of zeroes.

### Depth and motion

Two rules kept it honest: nothing moves unless the movement means something,
and the layout is never changed by an effect — every rule in that section can
be deleted and the page still measures identically to the prototype.

- A faint brand-tinted wash on the canvas, so white cards sit *on* something
  rather than float. Below the threshold of noticing, which is the point.
- Two blooms behind the hero at different speeds. Two gradients drifting
  against each other read as depth; one reads as a gradient.
- The estate figure settles in from a blur rather than appearing — the one
  number worth drawing the eye to, and a number that lands has more weight than
  one that was simply there.
- Action tiles grow a coloured bar from the left on hover, so the tile feels
  selected rather than merely lit. A tile with nothing waiting sits at 72%
  opacity: at rest, not merely grey.
- The van in the transit tracker has a halo, bobs gently, and the line behind it
  carries a slow travelling sheen. It is the one element representing something
  physically in motion right now, so it earns the attention.
- Donut segments lift when hovered; hovering the movement chart dims every month
  but the one under the cursor.
- Keyboard focus gets the same treatment as hover rather than a browser outline,
  so navigating without a mouse is not second-class.

All of it stops under `prefers-reduced-motion` — verified, not assumed.

**The stylesheet is copied from the prototype as one substring**, deliberately.
An earlier attempt extracted it rule by rule with a regex, which lifted every
mobile override out of its `@media` wrapper and applied it at all widths — so a
1440px screen wore 22px padding meant for a phone, and the hero lost its 26px
radius. Verified identical to the prototype at 1440px, 1100px and 390px.

## Notifications

Migration `0013` adds a queue. Nothing sends yet, and that is deliberate:
half-built notifications reaching real people is worse than none, and a queued
row you can read beats a fire-and-forget call you cannot.

Everything the system would send is written to `app.notifications` and shown at
`/notifications`, so you can see exactly what would go out — and to whom —
before wiring a provider and discovering it in your customers' inboxes. Doing
so is a few lines in `src/lib/notify.ts`.

Channel is a per-event choice, because field staff on location links have a
phone number and often no work email. Discrepancy alerts are locked on: they
are the safety net on the register, and a company that silences them discovers
its own losses months late.

## Status

Every screen is built and reading live data: assets, catalog, inventory,
transfers, requests, field inbox, people and links, locations, audit log,
diagnostics.

Not built: bulk import, reports, tags and scanning, disposal and maintenance
screens. All exist in the database already — they need pages, not migrations.
