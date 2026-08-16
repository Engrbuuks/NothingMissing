import { cookies } from 'next/headers';
import { server } from '@/lib/supabase';
import { objectKey, signUpload, usingR2, IS_PUBLIC, type Bucket } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Issues a short-lived URL the browser can upload to directly.
 *
 * This route IS the access control. R2 has no idea who the caller is, so every
 * check that Supabase Storage policies used to make a second time has to be
 * made here, once, properly:
 *
 *   * the caller is signed in
 *   * they hold the right role in the company they claim
 *   * the key is built server-side from that company's id, never taken from
 *     the request — otherwise anyone could ask for a URL writing into
 *     somebody else's folder
 *   * the content type is on an allow-list
 */
const LIMITS: Record<Bucket, { roles: string[]; mime: string[]; maxBytes: number }> = {
  branding: {
    roles: ['owner', 'admin'],
    mime: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'],
    maxBytes: 2 * 1024 * 1024,
  },
  receipts: {
    roles: ['owner', 'admin'],
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
    maxBytes: 10 * 1024 * 1024,
  },
  attachments: {
    // Anyone who may write to the register may attach a photograph — a
    // storekeeper reporting a fault is the main case.
    roles: ['owner', 'admin', 'manager', 'requester'],
    mime: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
    maxBytes: 25 * 1024 * 1024,
  },
};

export async function POST(request: Request) {
  if (!usingR2()) {
    return Response.json({ error: 'R2 is not configured.' }, { status: 501 });
  }

  const supabase = server(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Not signed in.' }, { status: 401 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const bucket = String(body.bucket ?? '') as Bucket;
  const limit = LIMITS[bucket];
  if (!limit) return Response.json({ error: 'Unknown bucket.' }, { status: 400 });

  const contentType = String(body.contentType ?? '');
  if (!limit.mime.includes(contentType)) {
    return Response.json({ error: 'That file type is not accepted here.' }, { status: 400 });
  }

  const bytes = Number(body.bytes ?? 0);
  if (!bytes || bytes > limit.maxBytes) {
    return Response.json(
      { error: `Keep it under ${Math.round(limit.maxBytes / 1024 / 1024)} MB.` },
      { status: 400 }
    );
  }

  // The company comes from the caller's memberships, never from the request.
  // Taking it from the body would let anyone name somebody else's company and
  // be handed a URL that writes into their folder.
  const { data: membership } = await supabase
    .from('memberships')
    .select('company_id, role')
    .in('role', limit.roles)
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return Response.json(
      { error: 'Your role does not allow uploading here.' },
      { status: 403 }
    );
  }

  const key = objectKey(bucket, (membership as any).company_id, String(body.fileName ?? 'file'));
  const url = await signUpload(key, contentType);

  return Response.json({ url, key, public: IS_PUBLIC[bucket] });
}
