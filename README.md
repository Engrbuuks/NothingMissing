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

## Search, filter, export, add

Every list screen carries a toolbar built the same way, and the choices behind
it are worth stating.

**Filters live in the URL, via a GET form.** A filtered register becomes a link
someone can send — "here is every generator at Ibadan that is overdue" — and the
back button behaves. A client-side filter would have neither property.

**Filtering happens in the query, not after fetching.** A register of 20,000
assets should not travel over the wire to show twelve rows. The one exception is
category, which sits two joins away and PostgREST cannot filter on a nested
relation's parent, so that one narrows after the fetch and is documented as
such in the code.

**Export honours the same filters and the same permissions.** What downloads is
what was on screen. If the caller's role cannot see costs, the cost columns are
dropped entirely rather than exported blank — a blank column invites someone to
assume the data is missing rather than withheld. An export is the easiest way to
walk financial data out of a system, so it asks the database the same question
the register does and gets the same answer.

| Screen | Search | Filters | Export | Create |
|---|---|---|---|---|
| Assets | tag, serial, name, holder | category, location, status | CSV | add asset, import |
| Inventory | SKU, name | category, location | count sheet | add item, issue, receive, move |
| Catalog | model, brand, type | category | — | category, type, brand, model |
| Transfers | waybill, reference, driver, vehicle | status | — | new transfer |
| Audit | action, reference, detail, person | entity, severity | CSV | — (append-only) |
| Locations | — | — | — | add, sweep, archive |

Verified against a live database: search returns the right rows, the location +
status filter narrows correctly, adding an asset works, a duplicate serial is
refused outright, a new unit inherits its model's service interval and appears
as overdue, and the stock ledger balances after an issue.

CSV escaping is unit-tested against commas, quotes, newlines and nulls — a
broken CSV opens fine and reads wrong, which is the worst kind of broken.

## Creating an account

`/sign-up` → confirm email → `/onboarding` → the company exists at its own
subdomain. Migration `0014` closes six specific loopholes, each a real way this
would have broken or been abused:

1. **No profile on signup.** Supabase writes `auth.users`, not `app.profiles`,
   so `create_company()` failed with a foreign key error on every single
   sign-up. Now a trigger on `auth.users`.
2. **Unlimited companies per account.** Ten owned, three per hour.
3. **Unverified email owning a company.** Anyone could squat a slug using an
   address they do not control. Confirmation required before creation.
4. **Forwarded invitations.** Tokens are hashed, single-use, expiring, and
   bound to the address they were sent to.
5. **Privilege escalation by invite.** An admin could mint an owner and then be
   removed by them. Only an owner invites an owner.
6. **Slug race.** Two sign-ups passing the availability check at the same
   instant both proceeded, and the second got a constraint error it could not
   act on. Now it retries.

## Deleting things

Migration `0015`. The line is not "important versus unimportant" — it is
whether anything else points at the row.

| | |
|---|---|
| **Deletes** | locations with no history, unused catalog entries, stock items that never moved, draft transfers, suppliers with no orders, link holders who never submitted, memberships |
| **Archives** | anything with history — and says so, with the reason and the way forward |
| **Never** | `audit_events`, `stock_movements` |

A location that has appeared on a waybill is referenced by that waybill, by
every asset that passed through, and by the audit rows describing those
movements. Deleting it makes the waybill print with a blank origin — and nobody
can tell whether that is a bug or a cover-up. So it archives, and the refusal
says exactly that.

Three bugs came out of building this, each one the previous fix's consequence:

- The location's *own* creation audit row blocked its deletion.
- Fixing that with `ON DELETE SET NULL` made the cascade itself an UPDATE, which
  the append-only trigger refused.
- The trigger now permits exactly one thing: releasing `location_id` to null
  with every other column identical. Not a general hole — a named exception,
  and the log is still immutable in every other respect. Verified.
- Then the deletion's own audit row tried to file itself *at* the location it
  had just deleted. A deletion event cannot reference the thing it deleted.

Closing a company archives it, revokes every field link, and retires the
address — nobody else can claim a URL whose links are still on people's phones.
Other people's submissions and the audit trail survive: that history is not the
owner's to erase.

## The marketing site

On the apex, in the `(marketing)` route group — deliberately not the
application's visual language. Home, pricing, security, about.

The pricing page says plainly that ₦180 per asset is a starting number, that
2,800 assets comes to ₦504,000 a month, and that we would rather be told it is
wrong than lose a customer to a figure picked before meeting them. The security
page lists what is not done — no SOC 2, no third-party pen test — because a
customer finds that out eventually and it is better volunteered.

## Documents, billing and consent (0016)

**Waybills are frozen.** Issuing one snapshots the company details, the route,
the driver and every line. A driver carries this through checkpoints, so the
copy in his hand has to keep matching the copy in the system — renaming a
location next month must not silently rewrite a document issued today.
Verified: after renaming Lagos HQ, the issued waybill still reads Lagos HQ.
A correction is a new revision with a new number; the original stays.

Printing goes through the browser's own dialogue rather than server-side PDF
generation. It produces a real PDF, respects the user's paper size, and needs
no headless Chrome running somewhere to break at 2am.

**Attachments** are metadata rows; files live in object storage under a key
namespaced by company, so a bucket policy can enforce the same separation the
database does. MIME types are an allow-list — the interesting attacks are
always the format nobody thought of.

**Billing** counts assets from the register rather than storing a number, so
the figure on the billing page is the same figure on the dashboard and cannot
drift from it.

**Consent** is versioned. A boolean cannot say *which* terms someone accepted,
which is the only thing that matters if it is ever disputed.

## Performance, measured (0017)

Twenty thousand assets in one company, row-level security active:

| | before | after |
|---|---|---|
| register page, 500 rows, 2 joins | 251 ms | 104 ms |
| search across tag, serial, holder | 259 ms | 120 ms |
| dashboard status rollup | 245 ms | 105 ms |
| audit log page | 245 ms | **7 ms** |

The first attempt added indexes and changed nothing, which was the useful
result. The plan showed why:

    Seq Scan on assets (rows=20005)
      Filter: (app.is_member(company_id) AND ...)

The policy called a function **once per row** — twenty thousand calls, each
running its own subquery. No index can help, because the filter is a function
call rather than a comparison the planner can push down.

Rewriting the policies on the hot tables as set membership, with `auth.uid()`
wrapped in a scalar subquery so it is evaluated once as an InitPlan, lets
Postgres use a hash semi-join instead. The rule is identical.

That last part was checked rather than assumed: after the rewrite, a rival
company still sees zero assets, zero audit rows and zero costs; a location
manager still sees one location and no financial data; and a cross-site move is
still refused by `WITH CHECK`. All 271 assertions still pass.

## Notifications, errors and legal

`RESEND_API_KEY` turns email on. Without it, messages queue and are visible in
the app but are not delivered — a missing key degrades to "nothing sent"
rather than a crash on an unrelated screen. WhatsApp and SMS queue but do not
deliver; they need a Nigerian provider account, and sending half-built messages
to real phone numbers is worse than sending none.

Errors report as structured JSON to the server log, carrying the same digest
the user was shown — so "it said reference a7f3c2" matches one specific
failure rather than a time range. `SENTRY_DSN` forwards them somewhere durable.

Terms and privacy are versioned pages, written for the Nigeria Data Protection
Act. The privacy notice states one limit plainly: actions someone took inside a
company's register stay in that company's audit log even if they leave and even
if they ask for removal. That log is the basis of somebody else's asset
register, the company is its controller, and we cannot erase it on an
individual's request.

## Payments (0018)

Two details about Paystack webhooks are easy to get wrong and expensive to get
wrong quietly, so both are handled explicitly.

**The signature is HMAC-SHA512, not SHA-256**, computed over the **raw request
body**. Hashing a re-serialised object works right up until a key order or a
unicode escape differs, at which point valid payments start being rejected for
no visible reason. Verified against eleven cases including a tampered amount, a
SHA-256 signature, a truncated one, and a re-serialised body — all rejected;
unicode bodies verify.

**Paystack retries for 72 hours**, so every event will arrive more than once.
Each is recorded by its Paystack id before anything is acted on, and the unique
index makes a duplicate a no-op. Verified: applying the same payment twice
reports `already applied` and changes nothing.

The webhook — not the browser redirect — is the authoritative signal. A
customer whose network drops after paying still gets what they paid for.

The amount is computed by the database from the register, never taken from the
form: a client-supplied amount is a client-supplied discount. A charge that
does not match what was owed marks the payment failed and writes a `bad`-toned
audit row rather than reconciling quietly.

The service role key is used in exactly one file, where there is no session
because the caller is Paystack and the proof is the signature.

## SMS and WhatsApp

Through Termii. International providers route poorly to MTN and Glo, and
delivery rate matters more than API elegance when the message is "your delivery
is three days overdue".

Nigerian numbers arrive in every shape a person might type — `08031234567`,
`+234 803 123 4567`, `8031234567` — and Termii wants `234` plus ten digits.
Getting that wrong means messages that silently go nowhere, so normalisation is
unit-tested across eleven inputs including a UK number, which correctly returns
nothing rather than being mangled into a Nigerian one.

Messages truncate at 300 characters: an SMS past 160 is billed as several, and
a notification costing four segments is one somebody eventually switches off.

## Paying by bank transfer (0019)

Paystack approval takes weeks in Nigeria, and bank transfer is how most B2B
actually pays anyway. A company sees the account details, transfers, uploads a
receipt, and somebody at our end confirms it.

**The awkward part is honest about itself.** Everything else in this system is
tenant-scoped — a query returns one company's rows because the database will
not return any others. Verifying a payment is inherently cross-tenant, because
the person confirming works for us rather than for the customer.

Rather than a superuser role, there is a **platform reviewer** who can see
exactly one thing: payment submissions, with the company name, the amount, the
reference and the receipt. Verified: a reviewer sees the queue and still reads
**zero** assets and **zero** audit rows from a company they are not in. The
guarantee on the security page stays true because the exception is one table
wide.

It is also audited from the customer's side. Confirming a transfer writes a row
into **that company's own log**, naming the reviewer:

    a transfer was confirmed — NGN 11,700 confirmed by Grace Aluko at
    Nothing Missing — paid up to 2026-10-10

If we can reach into a company, the company gets to see that we did.

Becoming a reviewer is a manual `insert` with no screen behind it, because a
button that grants cross-tenant visibility is a button somebody eventually
clicks by mistake.

Receipts upload from the browser straight to storage — a 5 MB photograph of a
bank slip has no business travelling through a server action — and are served
to reviewers through a two-minute signed URL rather than a public path. Bucket
policies are in `backend/STORAGE.md`, and they restate the same rule the
database applies, because the browser uploads directly and never passes through
our server.

## Brand and theming (0020)

The mark — the n and m with an open crate between them whose lid reads as a
tick — is drawn as SVG in `src/components/Mark.tsx` rather than shipped as a
PNG. It stays crisp at 26px in a sidebar and 200px on a document, and it can
carry a colour. The rasters in `public/brand` exist for email, which cannot be
trusted with inline SVG.

Colours were taken from the logo file rather than guessed: navy `#061F3E`,
blue `#0551BD`, crate face `#085ED5`. They are now the palette defaults.

**Two kinds of setting, kept apart deliberately.**

*Company theme* is one person's decision applied to everyone — colour, logo,
what prints on a waybill. Owner or admin only.

*View preferences* are personal — landing page, table density, which columns
the register shows, a default location. A manager checking deliveries all day
and an owner reading reports want different defaults, and neither should be
able to impose theirs on the other. The policy is `user_id = auth.uid()` in
both directions: an owner cannot read what a manager prefers, because it is not
their business and a preference table is not a surveillance tool.

**One colour, and everything derives from it.** Handing someone six pickers
produces documents with their name on them that they would be embarrassed to
send. A custom colour is allowed, but `set_company_theme()` computes relative
luminance and refuses anything too pale to carry white text — otherwise the
first they hear of an unreadable waybill is a customer complaining.

**A company's logo replaces ours in their sidebar and on their waybills.** A
document going to a checkpoint should carry their identity, not ours. The
waybill snapshot captures the logo path, so a document issued today keeps the
mark it was issued with even if they change it next month.

`branding` is the one public storage bucket, and deliberately: a signed URL
would expire while a printed waybill is still in somebody's hand, and a logo is
on the company's letterhead already.

## Status

Every screen is built and reading live data: assets, catalog, inventory,
transfers, requests, field inbox, people and links, locations, audit log,
diagnostics.

Not built: bulk import, reports, tags and scanning, disposal and maintenance
screens. All exist in the database already — they need pages, not migrations.
