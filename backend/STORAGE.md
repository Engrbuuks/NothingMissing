# Storage buckets

Two buckets, created once in the Supabase dashboard under **Storage**.

## `receipts` — private

Payment receipts customers upload. **Must be private.** A public bucket means a
receipt is readable by anyone who guesses the path, and a bank slip carries an
account name and often a partial account number.

Reviewers read them through `/admin/payments/receipt`, which mints a signed URL
valid for two minutes. Nothing is ever served directly.

Policies — Storage → receipts → Policies → New policy → *For full customisation*:

**Upload (INSERT), for `authenticated`:**

```sql
bucket_id = 'receipts'
and (storage.foldername(name))[1] in (
  select m.company_id::text
  from app.memberships m
  where m.user_id = auth.uid()
    and m.role in ('owner','admin')
)
```

The path starts with the company id, so this says: you may only write into your
own company's folder, and only if you are an owner or admin. It is the same
rule the database applies, enforced a second time at the storage layer — two
locks on one door, because the browser uploads directly and never passes
through our server.

**Read (SELECT), for `authenticated`:**

```sql
bucket_id = 'receipts'
and (
  (storage.foldername(name))[1] in (
    select m.company_id::text from app.memberships m
    where m.user_id = auth.uid() and m.role in ('owner','admin')
  )
  or exists (select 1 from app.platform_reviewers r where r.user_id = auth.uid())
)
```

A company reads its own receipts; a reviewer reads all of them. That second
clause is the same narrow exception the database makes, and the only one.

## `branding` — **public**

Company logos. The only public bucket, and deliberately so: a logo appears on a
waybill a driver hands to a third-party depot, and signing every one of those
would mean a URL that expires while the document is still in someone's hand.

There is nothing to protect — a logo is on the company's letterhead already.

Upload policy (INSERT and UPDATE), for `authenticated`:

```sql
bucket_id = 'branding'
and (storage.foldername(name))[1] in (
  select m.company_id::text
  from app.memberships m
  where m.user_id = auth.uid()
    and m.role in ('owner','admin')
)
```

Reading is public, so no SELECT policy is needed. Tick **Public bucket** when
creating it.

## `attachments` — private

Photos on fault reports, delivery notes, signatures. Same shape:

```sql
bucket_id = 'attachments'
and (storage.foldername(name))[1] in (
  select m.company_id::text from app.memberships m where m.user_id = auth.uid()
)
```

Membership of any role, because a storekeeper reporting a fault needs to attach
a photograph.

## If you skip this

The receipt upload fails with a clear message telling the customer to email the
receipt instead, and the payment form still submits without a file. That is
deliberate: a missing bucket should degrade, not block someone trying to pay you.
