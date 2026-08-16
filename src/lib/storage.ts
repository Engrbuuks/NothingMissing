import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Storage.
 *
 * Cloudflare R2 when it is configured, Supabase Storage otherwise. Both are
 * behind the same four functions so nothing else in the app knows or cares
 * which is in use.
 *
 * R2 is the better choice here for one reason that matters in Nigeria: egress
 * is free. Logos are fetched on every page load by every user, and a bucket
 * that charges for reads turns a branding feature into a line item.
 *
 * ── The trade-off, stated plainly ─────────────────────────────────────────
 *
 * Supabase Storage policies can query `app.memberships` directly, which meant
 * a private file had two independent locks: the application checked
 * permission, and the storage layer checked it again against the same tables.
 * A bug in one was caught by the other.
 *
 * R2 has no idea who the user is. Permission is checked once, here, before a
 * presigned URL is issued — which is how most systems work, and is fine, but
 * it is one lock rather than two. So:
 *
 *   * every private read goes through a route that checks permission first
 *   * presigned URLs are short-lived: two minutes to look at a receipt, ten
 *     to upload, rather than hours
 *   * keys are namespaced by company, so a leaked key reveals one object and
 *     not a listing
 *   * the bucket is never public and never has a custom domain in front of
 *     it, because a public URL is a permanent one
 *
 * Public assets — logos — are different. They are on a company's letterhead
 * already, they appear on a waybill a driver hands to a depot, and a signed
 * URL would expire while that document is still in somebody's hand. Those go
 * in a public bucket on purpose.
 */

export type Bucket = 'branding' | 'receipts' | 'attachments';

/** Public assets are served directly; private ones only ever through a signature. */
export const IS_PUBLIC: Record<Bucket, boolean> = {
  branding: true,
  receipts: false,
  attachments: false,
};

const R2_ACCOUNT = process.env.R2_ACCOUNT_ID;
const R2_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET ?? 'nothing-missing';
/** e.g. https://cdn.nothingmissing.ng — an R2 custom domain over the PUBLIC prefix only. */
const R2_PUBLIC_BASE = process.env.NEXT_PUBLIC_R2_PUBLIC_BASE;

export const usingR2 = () => Boolean(R2_ACCOUNT && R2_KEY && R2_SECRET);

let client: S3Client | null = null;
function r2() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_KEY!, secretAccessKey: R2_SECRET! },
    });
  }
  return client;
}

/**
 * Object keys carry the bucket name as a prefix inside one real R2 bucket.
 * One bucket is cheaper to administer and, more usefully, means the public
 * custom domain can be scoped to the `branding/` prefix — so a
 * misconfiguration cannot accidentally expose receipts.
 */
export function objectKey(bucket: Bucket, companyId: string, fileName: string) {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-80);
  return `${bucket}/${companyId}/${Date.now()}-${safe}`;
}

/** A URL the browser can PUT the file to directly. Ten minutes is plenty. */
export async function signUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    r2(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 600 }
  );
}

/**
 * A URL to read a private object. Two minutes: long enough to open a receipt,
 * short enough that a link pasted into a chat is dead before anyone else
 * clicks it.
 */
export async function signDownload(key: string, seconds = 120): Promise<string> {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), {
    expiresIn: seconds,
  });
}

/** Public URL for a logo. No signature, because it is meant to be permanent. */
export function publicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (usingR2() && R2_PUBLIC_BASE) {
    // The custom domain is mapped to the branding/ prefix, so strip it.
    return `${R2_PUBLIC_BASE.replace(/\/$/, '')}/${key.replace(/^branding\//, '')}`;
  }
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  // Supabase fallback: the key's first segment is the bucket.
  const [bucket, ...rest] = key.split('/');
  return `${base}/storage/v1/object/public/${bucket}/${rest.join('/')}`;
}

export async function removeObject(key: string): Promise<void> {
  if (!usingR2()) return;
  await r2().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

export async function objectExists(key: string): Promise<boolean> {
  if (!usingR2()) return false;
  try {
    await r2().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}
