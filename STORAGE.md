# Storage

Cloudflare R2 when configured, Supabase Storage otherwise. Both sit behind
`src/lib/storage.ts`, so nothing else in the app knows which is in use.

## Why R2

Egress is free. Logos are fetched on every page load by every user, and a
bucket that charges for reads turns a branding feature into a line item.

## The trade-off, stated plainly

Supabase Storage policies could query `app.memberships` directly. That gave
private files **two independent locks**: the application checked permission,
and the storage layer checked it again against the same tables. A bug in one
was caught by the other.

**R2 has no idea who the user is.** Permission is checked once, in
`/api/storage/upload-url` and `/api/storage/download`, before a signature is
issued. That is how most systems work and it is fine — but it is one lock
rather than two, and worth knowing.

What compensates:

- The company is derived from the caller's memberships and **never read from
  the request**. Taking it from the body would let anyone name somebody else's
  company and be handed a URL writing into their folder.
- Signatures are short: ten minutes to upload, **two minutes** to read a
  receipt — dead before a link pasted into a chat gets clicked.
- Keys are namespaced by company, so a leaked key exposes one object, not a
  listing.
- Private prefixes are never public and never behind the custom domain.
- `tests-storage.mjs` asserts all of the above and runs in CI.

## Setting up R2

**1. Create a bucket.** Cloudflare dashboard → R2 → Create bucket, named
`nothing-missing`. One bucket; the prefixes `branding/`, `receipts/` and
`attachments/` live inside it. One bucket is simpler to administer and lets the
public custom domain be scoped to `branding/` alone, so a misconfiguration
cannot expose receipts.

**2. Create an API token.** R2 → Manage API Tokens → Create, with **Object Read
& Write** on that bucket. Copy the access key id and secret — the secret is
shown once.

**3. Expose only the public prefix.** R2 → your bucket → Settings → Custom
Domains → add `cdn.nothingmissing.ng`. Then add a Cloudflare **Transform Rule**
or Worker that rewrites `/<path>` to `/branding/<path>`, so the domain reaches
the branding prefix and nothing else.

If that feels like more than you want today, skip the custom domain. Logos then
fall back to Supabase Storage, and everything else still uses R2.

**4. Environment variables:**

    R2_ACCOUNT_ID=
    R2_ACCESS_KEY_ID=
    R2_SECRET_ACCESS_KEY=
    R2_BUCKET=nothing-missing
    NEXT_PUBLIC_R2_PUBLIC_BASE=https://cdn.nothingmissing.ng

Leave them unset and the app uses Supabase Storage instead, with no code change.

## Supabase Storage fallback

Only needed if you are not using R2.

`branding` — **public**. A logo appears on a waybill a driver hands to a depot,
and a signed URL would expire while that document is still in somebody's hand.

`receipts` and `attachments` — **private**, with this policy on each:

```sql
bucket_id = 'receipts'
and (storage.foldername(name))[1] in (
  select m.company_id::text
  from app.memberships m
  where m.user_id = auth.uid()
    and m.role in ('owner','admin')
)
```

For `attachments`, drop the role condition — a storekeeper reporting a fault
needs to attach a photograph.

## If neither is configured

Uploads fail with a message telling the person to continue without a file, and
every form still submits. A missing bucket should degrade, not block someone
trying to pay you.
