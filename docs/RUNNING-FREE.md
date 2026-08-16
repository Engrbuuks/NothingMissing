# Running free, and creating accounts by hand

Two switches, both in `/admin/companies`. You need to be a platform reviewer:

```sql
insert into app.platform_reviewers (user_id, note)
values ('<your uuid from Authentication → Users>', 'Founder');
```

There is deliberately no screen for granting that — a button that hands out
cross-tenant visibility is a button somebody eventually clicks by mistake.

---

## 1. Everything free

Billing is **off by default**. Migration 0021 ships with `billing_enabled`
false, so nothing you do today turns it on by accident.

While it is off:

- every company's cost is ₦0 regardless of asset count
- the billing page says so plainly rather than showing a bill nobody owes
- `begin_payment()` **refuses** rather than half-working — a company cannot
  reach Paystack for an amount the system does not believe in
- the summary still computes `would_cost_minor`, so you can see what a company
  *would* pay without them being charged

Turning it on later is one switch. Verified: with it off a 125-asset company
owes ₦0; with it on the same company owes ₦22,500.

## 2. Free forever, for specific companies

Comping is separate from the switch, and that is the point. An early customer
who was promised free access should not start receiving invoices the day you
decide to charge everyone else.

Set it per company in `/admin/companies`, with a reason and an optional end
date. Verified: a comped company still costs ₦0 after billing is switched on.

The reason is not decoration — in a year you will not remember which promise
you made to whom, and "Early customer" against a company that is now large is
a conversation you want the context for.

## 3. Creating a company for someone

For when you have had the call and want them signed in tomorrow, rather than
sending them to a form.

**Step one — create the person's login.** Supabase dashboard →
Authentication → Users → Add user. Use their real email, tick **Auto Confirm
User**, and either set a password to share or send an invite.

**Step two — create the company.** `/admin/companies` → Provision. Enter their
email, their name, the company name, and a slug. It creates the company, makes
them owner, adds the virtual warehouse, and comps them by default.

They sign in at `<slug>.nothingmissing.ng` and it is theirs.

Why two steps rather than one: creating an auth user requires the service role
key, and putting that key in a page any signed-in reviewer can reach would mean
one bug away from an account-creation endpoint. The dashboard already does that
job safely.

---

## What this does not change

Provisioning does not weaken tenant isolation. A provisioned owner sees their
own company and nothing else — verified in the same test that verifies it for
everyone else.

A non-reviewer calling `provision_company()` is refused, and the refusal is at
the database, not in the page.
