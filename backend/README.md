# Asset Control — backend

Postgres schema, row-level security, and the operations that must be atomic.
Written for Supabase but with no Supabase-specific dependency beyond `auth.uid()`,
which `tests/00_shim.sql` provides locally so the same SQL runs in both places.

## Run the tests

    bash scripts/test.sh

Drops the database, replays every migration from empty, seeds two unrelated
companies, and runs 228 assertions. Any failure aborts with a non-zero exit.
This is what CI runs on every push.

## Layout

    supabase/migrations/
      0001_tenancy.sql          companies, profiles, memberships, locations, access helpers
      0002_rls_tenancy.sql      RLS for the above
      0003_audit.sql            append-only audit log + generic change trigger
      0004_catalog_assets.sql   catalog hierarchy, assets, financials behind their own permission
      0005_transfers.sql        transfers, waybills, discrepancies, archiving
      0006_inventory.sql        stock ledger, balances, counts, fuel reconciliation
      0007_requests.sql         request state machine, policies as data, delegation, escalation
      0008_field_links.sql      hashed location links, field submissions, review, trust records
      0009_procurement_lifecycle.sql  suppliers, purchase orders, goods receipt, maintenance, disposal
    supabase/tests/             228 assertions across 11 files
    scripts/verify_rls.sql      structural guard: RLS forced, policies present, WITH CHECK on writes
    supabase/seed.sql           two companies that must never see each other
    scripts/test.sh             rebuild, migrate, seed, assert

## The four decisions this schema encodes

**1. Access is decided by membership, never by a client-supplied "current company".**
A client can lie about which company it is looking at. It cannot lie about which
rows exist in `app.memberships`. Every policy resolves through
`app.is_member()`, `app.has_role()` or `app.can_access_location()`, all
`SECURITY DEFINER` so a policy on another table does not recurse into the
policies on memberships.

A membership with `location_id IS NULL` means the whole company. One with a
location is scoped to that site. A person may hold several.

**2. Every write policy pairs USING with WITH CHECK.**
`for all using (...)` with no `WITH CHECK` lets a caller update a row they can
see into a shape they should not be able to create — silently, no error. Test
02 proves the pairing: an Abuja manager can rename an asset at her own site,
and is blocked from moving it to a site she has no rights over.

**3. Purchase cost lives in its own table.**
Postgres RLS gates rows, not columns. `app.asset_financials` is a separate
table with a single policy, `app.can_see_financials()`. A location manager
querying an asset gets no financial row back at all — not a blanked one, not a
null. No conditional select logic anywhere in the application.

**4. The audit log is append-only at the database, not by convention.**
No UPDATE or DELETE policy exists, the privileges are revoked from the
application role, and a trigger raises regardless — so even the table owner,
whom RLS alone would not stop, cannot quietly tidy the record. Rows are written
by triggers inside the same transaction as the change they describe. If the
change rolls back so does its audit row; if the audit write fails the change
fails with it. Application code cannot forget to log something because
application code is not what logs it.

## The operation everything rests on

`app.accept_transfer(transfer_id, flagged_asset_ids[], notes)` moves every
unflagged line onto the destination register, opens a discrepancy for each
flagged one, stamps the waybill and writes the audit rows — in one transaction.
Test 05 proves the guarantee by breaking the destination mid-flight and
asserting that all four assets are still in transit, no line is marked
received, and no audit row claims success.

Two rules it enforces that are easy to miss:

- Only someone whose membership covers the **destination** may accept. That is
  the entire point of the step.
- Dispatch re-checks that every asset is still at the origin. If one moved
  after approval it refuses, rather than dispatching a line describing a world
  that no longer exists.

## Documents are numbered without gaps

Sequences skip on rollback, which is fine for surrogate keys and useless for
documents — an auditor asking why WB-2026-0147 does not exist is not satisfied
by "the transaction failed". `app.next_doc_number()` locks a counter row per
company per year. Test 06 proves a second company starts at 0001 rather than
continuing the first company's run.

## Locations archive, they never delete

Waybills, asset histories and audit rows all reference a location by id.
Dropping the row turns every one of those into a dangling pointer. So
`app.archive_location()` refuses while the site holds assets or has an open
consignment, `app.sweep_location()` moves the contents to the virtual
warehouse, and archiving hides the location everywhere while leaving it
resolvable in history. The virtual warehouse itself can never be archived —
it is where swept assets land.

## Three bugs the tests caught

Worth recording, because each one would have shipped.

1. **The test suite passed for the wrong reason.** `t.as_user()` used
   `set_config(..., true)`, which is transaction-scoped; psql runs each
   statement in its own transaction, so `auth.uid()` was null throughout and
   the isolation tests passed because the actor could see *nothing at all*.
   `t.assert_actor_persists()` now guards against this specific failure.

2. **`accept_transfer` was not safe to call twice.** After a partial receipt
   the transfer stays `in_transit` while a discrepancy is open, so a second
   call would re-process already-received lines and open a duplicate
   discrepancy for the same asset. It now only touches lines where
   `received is null`, and closes the waybill on outstanding lines rather than
   on that call's flag count.

3. **Two tests asserted the wrong shape of failure.** RLS hides rows rather
   than rejecting statements, so an UPDATE aimed at another tenant succeeds and
   affects nothing. Asserting "it raised" was asserting something untrue; the
   assertion is now that zero rows changed, verified from the owner's side.

## Stock: how a quantity goes down (0006)

A stock level is never a column you UPDATE. It is the sum of an append-only
ledger, `app.stock_movements`, with `app.stock_balances` as a trigger-maintained
cache and `app.verify_stock_integrity()` to prove the two still agree. If stock
is a mutable number, "why is there 3,910 litres?" has no answer — someone typed
it. As a ledger sum, every litre is attributable.

Fuel forces this, because it goes down three different ways and only one is a
deliberate act:

| | what it is | how it is recorded |
|---|---|---|
| **Issue** | someone drew 200 litres for a generator | `app.issue_stock()` — signed movement, with the asset and meter reading |
| **Consumption** | the engine burned it | never entered; derived from meter movement × the model's burn rate |
| **Shrinkage** | evaporation, spillage, bad gauges, theft | never recorded by anyone; only appears as the gap a physical count finds |

Shrinkage cannot be obtained by subtracting issues. It is found by counting.
`app.post_stock_count()` writes a `count_adjust` movement for exactly the gap,
carrying the counter's name and their explanation — so a 90-litre loss is a row
that says who found it and why, not a number that quietly changed.

**The fuel check.** `app.fuel_reconciliation(asset)` compares litres issued
against what the engine could have burned, taking the burn rate from the catalog
model and the hours from meter readings captured at each issue. It returns the
unexplained volume in litres and a flag of `normal`, `watch` or `investigate`.
A tolerance is essential: load varies and gauges drift, and a system that cries
theft at every 3% discrepancy is ignored within a fortnight.

Its limitation is stated in the migration rather than hidden — it compares fuel
*issued* to fuel *burned*, which differ by whatever sits in the tank at each end
of the window. Over one fill the gap looks large; over a month it washes out.
Tank readings at both ends would close it properly. Until then the flag is a
prompt to go and look, never an accusation.

Other rules the ledger enforces: quantities are signed so direction cannot drift
from a separate column; indivisible items reject fractional quantities; a
transfer posts both legs or neither; and stock cannot go negative without an
explicit override, because a negative balance almost always means an unrecorded
receipt rather than a genuine shortage — so the error says so.

## Two more bugs the tests caught

4. **The burn rate was being regex-parsed out of a free-text spec string.**
   "19.8 L/hr at full load" happens to yield 19.8, but the same expression
   against a model number like "1104A-44TG2" would cheerfully return 1104. A
   number the system reasons with belongs in a typed column, so
   `models.consumption_rate` now exists and an asset whose model has none
   reports `no_burn_rate` rather than inventing a figure.

5. **A test asserted the wrong flag.** 360 litres issued against 158 the engine
   could burn is a 127% overage and correctly reads `investigate`; the test
   expected `watch`. The function was right.

## Requests and approvals (0007)

Approval rules are **data, not code**. A policy is a row with ordered steps and
bounds; the chain for a request is built by matching amount and item count
against policies in priority order, first match wins. Company A wanting one
approver under ₦500k and two above it is two rows, not a deployment.

Three rules the state machine enforces:

- **Nobody approves their own request**, whatever role they hold. This check
  runs *before* the role check, because an admin raising their own request
  would otherwise pass the role test and approve it.
- **Seniority satisfies a junior step.** An owner can sign where an admin is
  called for; a manager never satisfies an admin step. Without this, a policy
  naming `admin` is unapprovable in a company whose only senior person is the
  owner — every small customer stuck on day one.
- **A timeout escalates to another human; it never auto-approves.** Once people
  learn that ignoring a request approves it, ignoring becomes the strategy.
  Skips are recorded distinctly so an auditor can find every movement that did
  not follow the normal chain.

Delegation covers approvers on leave without handing over their account.

## Field links (0008)

The threat model assumes **the URL is public knowledge** — it will be forwarded
over WhatsApp, screenshotted, and sit in a phone that gets lost. So:

- The token is stored **hashed**. A database leak yields no working link.
- A link grants a narrow verb set at **one** location, and `anon` is denied at
  the privilege level on every table — not merely filtered by policy, which
  would still hold if a future migration added a careless one.
- **Nothing a link submits changes anything.** It creates a pending row a
  manager reviews. The blast radius of a stolen link is "somebody submitted a
  wrong count", not "somebody moved our generators".
- Expired, revoked, unknown and over-quota tokens all fail identically, so
  probing learns nothing.

A submission never shows the counter what the system expects — if it did they
would agree with it and the count would be worthless. The comparison happens
only on the reviewer's screen. And the **accuracy record is a by-product of
reviewing**, never typed in: it is what tells you whose figures to spot-check.

## Procurement and lifecycle (0009)

**Goods receipt refuses to invent assets.** Three units arriving with two
serials is rejected outright. If the goods genuinely carry no nameplate the
line must be marked unserialised explicitly — a decision someone makes, not a
gap the system papers over. Twelve identical chairs with no serials are twelve
rows that will drift from reality within a year.

**Maintenance intervals live on the catalog model**, so buying six more of
something schedules all six with no configuration. Due state is computed from
meter movement since the last logged service.

**Disposal demands evidence per reason**, enforced in the function rather than
the form: a police reference for a theft, a scrap note for a scrapping,
proceeds for a sale. A theft with no reference is exactly the pattern an audit
flags. Disposals cannot be inserted directly, so the rules cannot be sidestepped.

**Supplier lead time is computed** from issue and receipt timestamps — which is
how you discover the supplier promising two weeks has averaged three.

## The structural guard

`scripts/verify_rls.sql` runs in CI after the migrations and fails the build if
any table in `app` lacks forced RLS, any tenant table has no policy, or any
write policy omits `WITH CHECK`. All three are silent mistakes otherwise. It is
verified to catch each case rather than passing vacuously.

## Three more bugs the tests caught

6. **The self-approval check ran after the role check.** An admin raising their
   own request would have passed the role test and approved it. Separation of
   duties is not conditional on which role you hold, so the check moved first.

7. **Seniority did not satisfy junior steps.** `has_role` matches exactly, so a
   policy naming `admin` could not be signed by an owner. Every owner-only
   company would have been stuck on their first two-step approval.

8. **`pgcrypto` was not on the search path** of the security-definer functions,
   so `digest()` resolved locally and would have failed on Supabase, where the
   extension lives in a different schema.

## Running against Supabase

`scripts/test_supabase_layout.sh` replays every migration against Supabase's
actual extension layout — pgcrypto pre-installed in the `extensions` schema
rather than in `public`. That difference is invisible locally and fatal on
deploy: `CREATE EXTENSION IF NOT EXISTS pgcrypto` becomes a silent no-op and
`digest()` then fails to resolve inside SECURITY DEFINER functions.

Every such function pins `search_path = app, extensions, public, pg_temp`, so
the same SQL resolves identically in both places. The check runs in CI and is
verified to catch the failure rather than passing vacuously.

## Not built yet

The API layer and the front end. Every table, policy and operation the
prototype demonstrates now exists in the database.
