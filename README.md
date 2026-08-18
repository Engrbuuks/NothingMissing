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

## Two branding bugs, and how to find the next one

**The company details form was resetting the colour.** It carried a hidden
`brand` field holding whatever the colour was when the page rendered, and wrote
it back on save — so changing a phone number silently reverted the theme. Two
forms owned one field. Now only the appearance form does.

**Dark mode was stored but never applied.** The control existed, the value
saved, and nothing happened, because no CSS read it. It now re-points the
tokens rather than inverting anything: `--canvas` becomes the dark surface,
`--surface` the lighter card, the text scale flips. Every component already
reads those, so nothing else changed.

Branding passes through four layers — the migration, the stored value,
`resolve_tenant`, and the storage bucket — and a failure in any of them looks
identical from outside: nothing changes. So `/diagnostics` now checks each
separately and says which one broke, including fetching the logo to confirm the
bucket actually serves it.

## Storage: Cloudflare R2

R2 when configured, Supabase Storage otherwise, both behind
`src/lib/storage.ts` so nothing else knows which is in use. Egress is free,
which matters because logos are fetched on every page load by every user — a
bucket that charges for reads turns a branding feature into a line item.

**The trade-off is real and worth naming.** Supabase Storage policies could
query `app.memberships` directly, so a private file had two independent locks:
the application checked permission and the storage layer checked it again. R2
has no idea who the user is, so permission is checked once, before a signature
is issued. That is how most systems work, and it is fine — but it is one lock
rather than two.

What compensates, all asserted by `tests-storage.mjs` in CI:

- The company is derived from the caller's memberships and **never read from
  the request** — otherwise anyone could name somebody else's company and be
  handed a URL writing into their folder.
- Ten minutes to upload, **two minutes** to read a receipt.
- Keys namespaced by company, so a leaked key exposes one object rather than a
  listing.
- Only `branding/` is public, and a public asset is refused a signature —
  a printed waybill must not stop working when a signature expires.
- The browser client contains no access-control logic at all.

Setup is in `backend/STORAGE.md`. Leave the R2 variables unset and everything
falls back to Supabase Storage with no code change.

## Free accounts (0021)

**One switch turns billing off for the whole platform**, and it is off by
default — a billing system that is on by default is one that charges somebody
during a trial by accident. While it is off, `begin_payment()` refuses, the
billing page shows the free notice instead of an amount, and the payment card
is not rendered at all. Showing a "you owe" figure nobody will collect is the
fastest way to make a free product feel like a trap.

The page still computes `would_cost_minor` and labels it plainly, so nothing is
a surprise later.

**Comped accounts survive the switch being turned back on.** An early customer
promised free access should not discover an invoice the day billing starts, so
the exemption is a recorded fact on the company with a reason and an optional
expiry — not an absence of a subscription row. Granting or ending it writes to
**that company's own audit log**: if we change what somebody pays, they see it.

**`provision_company()` creates a working company for someone who has not
signed up** — profile, company, owner membership, virtual warehouse, optionally
comped. The first customers are onboarded in a conversation rather than through
a form, and doing that by hand in SQL is how a company ends up without an owner
or without its virtual warehouse.

It cannot create the login: passwords and confirmation emails are Supabase
Auth's job, and duplicating that would mean holding a credential we have no
business holding. If no account exists it refuses and says exactly what to do.

`/admin/companies` shows every company's name, size and plan — and nothing
else. Verified: a reviewer sees the list and still reads zero assets from a
company they are not in.

### A duplicate migration, found while building this

There were two files numbered `0019` — `bank_transfer` and `manual_payments` —
implementing the same feature two different ways, with `actions.ts` calling
functions from both. Two files with the same number apply in whatever order the
shell happens to glob them, which is not a thing to leave in a repository. The
orphaned migration and its two dead actions are gone; the pages only ever used
the surviving one.

## Specifications (0022)

`models.specs` was a freeform jsonb array, so one person typed "24 inch",
another `24"`, a third "610mm". Nothing could be filtered or totalled, and in
practice nobody filled it in — an empty box with no label is an invitation to
skip.

Attributes are now **defined per category, once**. A chair is never asked for a
processor; a computer is never asked for upholstery. The form for a new model is
generated from its category, which makes it short, obviously relevant and
answerable — and every answer lands in the same typed field, so it is comparable
across models.

Five kinds: text, number, dimension, choice, boolean. A choice with fewer than
two options is rejected by a constraint, because a choice field with one option
is a text box wearing a costume, and comparability is the entire point.

**Three levels, and the third matters most.** Category defines what to ask,
the model holds the answer all units share, and an **asset override** holds
what is true of one unit alone. Without that third level somebody edits the
model to record an upgraded machine and silently changes the description of
forty others. The asset page shows which is which:

    Memory   16 GB   [This unit only]   Upgraded March 2026
    Screen   24 in   [Model]

A starter set is offered based on the categories a company already has —
computers get processor and memory, furniture gets material and dimensions.

Two bugs worth recording:

- The seed matched category names with `'comput|it|electron'`, and the
  unanchored `it` matched **furn*it*ure** — so chairs were asked for a
  processor. Word boundaries now.
- `model_specification` mixed a comma-join with a LEFT JOIN, which puts the
  earlier table out of scope. Postgres rejected it outright, which is the good
  case; a CROSS JOIN fixes it.

`docs/ASSETS-INVENTORY-CATALOG.md` explains the three concepts for whoever ends
up administering this.

## Running free (0021)

Billing ships **off**. `billing_enabled` is false by default, deliberately: a
billing system that is on by default is one somebody forgets to check before
inviting their first customer.

While it is off every company costs ₦0 whatever its asset count, the billing
page says so plainly, and `begin_payment()` refuses rather than sending
somebody to Paystack for an amount the system does not believe in. The summary
still computes `would_cost_minor`, so you can see what a company *would* pay
without charging them.

**Comping is separate from the switch**, and that is the point — an early
customer promised free access should not start receiving invoices the day you
decide to charge everyone else. Verified: with billing off a 125-asset company
owes ₦0; switched on, the same company owes ₦22,500 while a comped one still
owes nothing.

**Provisioning** creates a company for somebody who never signed up, for when
the sales conversation already happened. Two steps on purpose: the auth user is
created in the Supabase dashboard, because creating one needs the service role
key and putting that key behind a page any reviewer can reach is one bug away
from an open account-creation endpoint.

A provisioned owner sees their own company and nothing else — checked by the
same assertions that check it for everyone else. `docs/RUNNING-FREE.md` has the
steps.

## Catalog, assets, inventory (0022–0023)

The three are not obvious from the words, and getting them wrong is expensive
to undo — so the distinction is now stated in the app, collapsed by default, on
both the catalog and inventory pages where the confusion actually happens.

**Catalog** is the description, written once. **Assets** are the individual
things, each with its own tag, serial, location and history. **Inventory** is
the countable stuff, where one unit is interchangeable with any other.

The test: would you ever ask *"where is that specific one?"* If yes it is an
asset. `classification_hint()` warns — not refuses — when somebody creates a
stock item called "laptop", because a company that genuinely counts its chairs
is not wrong, and being told it is wrong by software is how people stop reading
messages.

**Attributes are defined per category**, so a chair never asks for a processor.
Three levels, and the third matters most: category attributes say what any
thing of this kind has, model values say what this kind has, and asset
overrides say what is true of one unit and nothing else. Without that third
level somebody upgrading one machine's memory edits the model and silently
changes the description of forty others. Verified: one unit reads 16GB, its
siblings still read 8, and the model is untouched.

**Starter packs** (0023) were the missing half. 0022 built the mechanism but
left a new company facing an empty attribute editor — which is exactly as
useless as the freeform text box it replaced, because somebody has to invent
"what does a chair have?" before describing a single chair. Seven packs now
create the category, a type under it, and five or six fields together.

They are short on purpose. Fifteen attributes on a chair means nobody fills any
in; six means the form is answerable in a minute, and six filled fields beat
fifteen empty ones.

## Adding a branch (0024)

The old import needed a location to already exist, took three columns, and
committed straight from the paste box. That meant five screens of setup —
location, category, type, brand, model — before a single asset could be
entered, which is where people gave up.

Now it is paste, preview, confirm. `import_branch()` creates the location, the
categories, the types, the brands and a catalog model per distinct make and
model, then the assets linked to all of it. Verified: 200 assets sharing four
models, 200 unique generated tags, nothing rejected.

**Dry run first.** The same function with commit off reports exactly what it
would create and reject, and writes nothing. Importing 400 rows and discovering
afterwards that a column was misread is how somebody ends up with 400 assets
called "Qty".

That preview had a bug worth recording: it counted six new brands for a file
naming two, because it could not deduplicate by querying when it writes
nothing. It now tracks what it has already counted, and dry run and commit
report identical numbers.

**Header matching is deliberately generous.** `S/N`, `Serial No.` and
`Serial Number` all resolve; so do `Make` and `Manufacturer`, `Description` and
`Item`. Tabs work as well as commas, because people paste out of Excel.
`tests-parse.mjs` covers fourteen header spellings and runs in CI — it caught
`Serial No.` failing, where stripping the full stop left a trailing space
because the trim happened before the collapse rather than after.

Only `Name` is required. Tags are generated for rows without one, carrying on
from the existing numbering.

## Four things that were wrong (0026)

Found by probing the database as each role, not by reading the code. Every one
of these looked correct in the source.

**A requester could retire any asset.** Retiring removes something from every
live register — the most destructive act short of disposal — and the most
junior writing role could do it to anything in scope. The role exists so a site
clerk can add what arrives and correct a holder, not so they can quietly empty
a depot. Now manager and above, enforced by trigger so it holds wherever the
update comes from.

**Serials and tags could be silently overwritten.** The serial is the one field
tying a database row to a physical object — what an auditor matches against and
what a scan resolves. Anyone with write access could replace it, making the
register describe a different machine with nothing on screen saying so. Now
owner or admin only. Filling in a *blank* serial is still open to anyone, because
somebody walking the floor with a scanner is exactly the behaviour to encourage.

**The audit log said "updated assets" and nothing else.** The before and after
states were captured correctly, so the trail was intact — but nobody could see
what changed without querying jsonb by hand, and a trail nobody can read is a
trail nobody checks. It now reads: *"name changed from Unit to Renamed unit,
holder set to Musa Ibrahim"*.

**Nothing encouraged a second owner.** Several were always permitted, but a
company whose only owner leaves is unreachable — only an owner can make another
owner. There is now a role control on the People page, a warning when a company
has exactly one owner, and `set_member_role()` refuses to let the last owner
demote themselves.

`role_capabilities()` returns what each role can and cannot do as data, and the
People page renders it. The description and the behaviour cannot drift apart
because they are the same source.

## Letting people in (0027)

Two gaps, found by using the system as a new company rather than as its author.

**Invitations existed but nothing reached them.** 0014 built `invite_member()`,
`accept_invitation()` and the `/join` page, and all of it worked — but the
People page never called any of it. The only way to add a second person was to
write SQL, which means in practice nobody but the founder ever signed in. A
feature nothing reaches is a feature that does not exist.

Verified end to end: invite issued, previewed by the recipient before signing
in, accepted, membership created with the right role and location, and the new
person immediately adds an asset.

**A name could not be changed.** It came from `auth.users` metadata, written at
sign-up and editable nowhere. Somebody who signed up as "Test" was stuck with
it on every audit row and waybill. There is now a profile page, reachable by
clicking your own name in the sidebar.

Renaming does **not** rewrite audit rows already written — they keep the name
held at the time. If a rename could rewrite the log, renaming would be a way to
quietly edit history.

**Renaming the company** is free; the slug is not. Every field link already
shared and every waybill already printed carries the slug, so it stays fixed
while the display name changes.

`docs/ADDING-PEOPLE.md` covers the whole thing, including why a company should
promote a second owner early: only an owner can make another owner, so a single
owner leaving makes the company unadministrable.

## The gap that kept recurring

Twice I shipped working database functions with no page calling them, told you
it was built, and it was not. Invitations were the second time: `invite_member()`,
`accept_invitation()` and `/join` all worked, and the People page reached none
of them.

From a user's seat that is indistinguishable from never building the feature.

`tests-reachable.mjs` now walks every exported server action and fails if no
page references it. Running it the first time found six more: draft transfer
deletion, supplier delete and archive, link-holder removal, member removal, and
a superseded import path left behind by 0024. All six are now wired or removed.

It runs in CI, so this specific failure cannot ship again.

## Sanity constraints (0028)

Found by probing the database with deliberately wrong data, not by reading.
Most constraints already held — stock cannot go negative, costs and reorder
points cannot be negative, blank names and duplicate tags are refused. Three
were not covered.

**An asset could be acquired in 2027.** A future date makes the age profile
nonsense and puts the asset outside every depreciation window. Tomorrow is
still allowed, because entering a delivery arriving in the morning is
reasonable; a year out is a typo.

**A meter could go backwards, silently.** 5,000 hours to 100. This is the
serious one: fuel reconciliation compares litres issued against hours run, so a
dropping meter makes a genuine loss look like a surplus — the one check
designed to catch theft stops working.

It is not a refusal, because meters legitimately reset when an engine or
dashboard is replaced. A drop is accepted *with a reason*, and logged as a
`warn` event. That is the difference between an event and a mistake.

**A transfer could go from a place to itself**, producing a waybill that reads
as an error to whoever receives it.

Every constraint is added `NOT VALID`, deliberately: a company that already
imported one bad date should be able to deploy and then fix the row, not have
the migration refuse to apply and leave them stuck. New writes are checked
immediately.

`data_health()` surfaces what needs tidying — future dates, missing serials,
assets with no catalog model, locations never stock-counted — on the
Diagnostics page, so somebody finds it there rather than when a constraint is
validated months later.

## Three more CI checks

`tests-links.mjs` walks every internal `href` and fails on one pointing at a
route that does not exist. The build compiles happily with a dead link;
nothing else catches it.

An empty-state audit found five pages that render a bare table with no rows and
no explanation — which looks broken. The two that a real user hits are fixed: a
new company's Locations page now explains the virtual warehouse and offers the
branch import, and the import preview handles a paste it could not read.

## What the new checks found (0028)

Rather than guessing at what else was broken, I wrote checks for the failure
modes I had already hit twice, and ran them.

**Six forms were missing fields their actions read.** A form that omits a field
its action reads submits happily and sends null — no error, nothing in the log,
the value quietly lost. The worst was `decide_request`: rejecting a request
silently discarded the reason, so the person whose request was refused was
never told why. Also missing: the note on returning a machine to service, the
comp end date, and — most consequentially — the asset and job reference when
issuing stock.

**That last one meant the fuel check could never run.** Naming the asset is
what makes the comparison possible, and the form had no field for it.

**The fuel check had no screen at all.** `fuel_reconciliation()` has worked
since 0006, but it takes one asset id — so using it required already knowing
which generator to suspect, which is the thing you do not know. Nothing called
it. The marketing site sells "shrinkage you can find" and the product had
nowhere to find it. `fuel_fleet()` and `/fuel` fix that: verified at 40 hours
run, 1,800 litres issued against 740 the engine could burn — 1,060 litres
flagged.

**Waybills were never created.** The page reads `waybill_documents`, the
snapshot function existed, and nothing wrote a row — so "Print the waybill"
always said none had been issued. Dispatch now issues one, and a failure to
prepare the document does not undo the dispatch: the assets have left the
origin register, and that is the fact that matters.

**The data export the privacy notice promises had no button.**

`tests-forms.mjs` joins the CI suite. It found all six mismatches, and it is
the sort of thing that reads as pedantic until you notice the rejection reason
was being thrown away.

## Three more silent failures (0029)

**Notification delivery status never saved.** `notify.ts` marks a message sent
after the provider answers, and `app.notifications` had no UPDATE policy — so
the write silently affected zero rows. Every notification stayed `queued`
forever: the page would show a growing pile of apparently undelivered messages
that had in fact been delivered, and any retry built on that status would
resend them. A write with no matching policy does not error, which is the worst
kind of failure.

Delivery fields can now be updated and nothing else — a notification is a
record of what was sent, and if the body could be edited afterwards it would
stop being evidence of anything. Attachments got the same treatment: the
caption is correctable, the file it points at is not.

**Three redirect messages were swallowed.** An action redirected with
`?error=…` to a page that never read the parameter. On `/transfers` that meant
a failed dispatch showed nothing at all — the user clicks, something goes
wrong, and the screen is unchanged.

**A bare `insert` into companies had no policy.** Nothing was visibly broken
because sign-up runs as SECURITY DEFINER, but a policy nobody decided on is a
trap for the next person. It is now explicitly `with check (false)`, with a
comment saying why: companies are created by `signup_company()`, which sets up
the owner and virtual warehouse in the same transaction. A bare insert would
leave a company nobody belongs to.

### The checks themselves needed fixing

Three of the four new checks reported working code as broken on their first
run, which is worse than not checking at all — a check that cries wolf gets
ignored, and then it is there for the one time it is right.

- The write-policy check grepped the migrations and missed policies generated
  in a loop. It queries `pg_policies` now.
- The RPC-argument check could not parse `DEFAULT NULL::uuid`, because the
  comma inside the default broke the argument split. It reads `pg_proc` now.
- The link checker split each href on `?` before collapsing `${…}`, which
  truncated `/catalog/${a.models?.id}` at the optional chaining.

Both database checks run inside `backend/scripts/test.sh`, alongside the RLS
guard, rather than as separate text-matching scripts.

## Authentication was broken (no migration)

**The auth callback route did not exist.** Supabase sends a one-time code that
must be exchanged for a session, and sign-up pointed its confirmation email
straight at `/onboarding` — a page that requires a session. So every new
sign-up clicked the link, landed somewhere that immediately bounced them to
sign-in, and had no route through. Nothing in the logs would have explained it.

**There was no password reset at all.** Anyone who forgot their password was
locked out permanently, with no way back except editing the database.

Both are built. `/auth/callback` handles confirmation, recovery and invitation
links; recovery goes to `/auth/update-password` regardless of `next`, because
otherwise somebody arrives signed in having never chosen a password and the
reset silently does nothing. The reset page shows the same screen whether or
not an address is registered — saying "no such account" turns it into a way to
find out who your customers are.

`tests-auth.mjs` covers seventeen properties of the auth wiring and joins CI.
Authentication is the one path where a mistake locks everyone out, and it had
no check at all.

**`docs/AUTH-SETUP.md`** covers the three Supabase dashboard settings the code
depends on. The redirect URL allow-list is the one that bites: without the
entry, confirmation emails fail with no clue why.

## Where people land (0030)

Three bugs, all the same shape: the application knew how to authenticate
somebody but not where to put them afterwards, and three screens each worked it
out separately.

**Signing in on the apex landed on the marketing site.** Sign-in sent people to
`/`, which on nothingmissing.ng has no tenant and redirects to `/home`. A
signed-in owner was looking at a page inviting them to start free.

**An invited person was offered a new company.** The join page said "create an
account", sign-up confirmed the address, and the callback sent them to
`/onboarding` — which asks them to name a company. Somebody invited to join
Zenith would have founded a second, empty Zenith and wondered why the register
was blank.

**Nothing could tell an invitation was waiting**, so no screen could route
around it.

`where_do_i_go()` is now the single answer, used by sign-in, the auth callback
and the apex root alike. An invitation outranks a company; a company outranks
onboarding; more than one company means choosing, because guessing sends
somebody to a register they were not thinking about.

`accept_my_invitation()` works by address rather than token, so somebody who
confirmed their email and came back without the original link is not stranded.
The invitation was bound to that address, so this grants nothing the token
would not have.

Onboarding now warns anybody with a pending invitation before they can found a
company by mistake.

The message check caught one of my own new bugs while I was writing this: an
error from `acceptMyInvitation` redirected to a page that never displayed it.

## Invitations actually send (no migration)

**The invitation system generated a token and handed it back to be copied.**
That is not an invitation system — it is a token generator with homework, and
it meant in practice nobody was invited.

Now the email goes out, by whichever route fits:

- **No account yet** → Supabase's admin invite creates the user and emails a
  link that sets their password. They never see a sign-up page at all, which is
  what made staff registration look like company registration.
- **Already has an account** → a branded Resend email with the join link,
  because Supabase would refuse to create them twice.
- **Neither configured** → the link is shown, marked as a fallback rather than
  the plan.

`/sign-up` now says plainly that it starts a *company*, and points anybody
who was invited at their email instead. The join page no longer offers
sign-up at all, because by then the account already exists.

## Twelve notifications that never sent

`notify()` was fully built, `notification_prefs` seeded twelve events, the
settings page listed them — and **nothing in the application ever called it**.
A company could switch a notification on, see it in the list, and never receive
one. The toggle described something that did not happen.

`announce()` now wires the two the product is sold on: a dispatch, so the
destination knows a consignment is coming, and a discrepancy, which is the one
event a company cannot switch off. The other ten remain unwired and
`tests-notify.mjs` reports them by name on every run, so they are visible
rather than forgotten.

This is the third time a complete, working, tested feature shipped with nothing
calling it. The reachability checks now cover server actions, database
functions, forms, redirect messages and notification events — each one added
after the same mistake.

## Purchase orders and the approval hierarchy (0031)

Two things were modelled but had no way in, and both were fair criticism.

**Purchase orders could not be created.** The table, the lines, the statuses
and `receive_goods()` all existed since 0009 — with no function to raise one
and no page to do it from. The screen listed orders that could never come into
being.

`/purchase-orders/new` now raises a draft, and issuing it is a separate,
deliberate step: a draft is somebody thinking, an issued order is a commitment
to a supplier. Cancelling requires a reason, because "cancelled" on its own
answers nothing when somebody asks in six months.

The line kinds matter and the schema was right to insist on them. An **asset**
line must name a catalog model, because receiving it creates a tagged unit that
inherits a specification. A **stock** line must name an item, because receiving
it moves a balance. Anything else is a **service** — labour, transport, a
callout. My first version defaulted everything to 'asset', which would have
created assets with no model: exactly what the catalog exists to prevent.

**The approval hierarchy could only be set in SQL.** `approval_policies` is
what decides that a ₦2m purchase needs two signatures and a ₦40k one needs
one — and there was no screen for it, so every company ran on whatever the seed
contained or on nothing at all. I flagged this as a gap early and did not build
it, which made the approval chain a feature in the documentation rather than in
the product.

`/approvals` now shows the rules per request type and lets an owner or admin
add and remove them. Companies get a sensible default hierarchy on creation —
one signature for small purchases, two above ₦500,000, two for any disposal —
because a company with no rules has no hierarchy and nobody notices until a
request sits unapproved.

Three guards are worth naming: an empty chain is refused rather than silently
letting everything through; four signatures is the ceiling, because beyond that
people stop reading and start clicking; and the last rule for a request type
cannot be deleted without a replacement.

The reachability checks caught three gaps in what I had just written — a cancel
action with no form, a form missing a field its action read, and a confirmation
message no page displayed.

## Status

Every screen is built and reading live data: assets, catalog, inventory,
transfers, requests, field inbox, people and links, locations, audit log,
diagnostics.

Not built: bulk import, reports, tags and scanning, disposal and maintenance
screens. All exist in the database already — they need pages, not migrations.
