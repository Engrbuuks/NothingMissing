'use client';

/**
 * Uploading from the browser.
 *
 * The file goes straight to storage rather than through a server action —
 * a 10 MB photograph of a bank slip has no business travelling through a
 * function that has a body-size limit and a timeout.
 *
 * The server issues the URL after checking permission, so this file contains
 * no security decisions at all. The size and type checks here are for a fast
 * answer, not for safety: the route checks both again, and the route is what
 * counts.
 */
export type UploadResult =
  | { ok: true; key: string; isPublic: boolean }
  | { ok: false; error: string };

export async function uploadFile(
  bucket: 'branding' | 'receipts' | 'attachments',
  file: File
): Promise<UploadResult> {
  let signed: Response;
  try {
    signed = await fetch('/api/storage/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket,
        fileName: file.name,
        contentType: file.type,
        bytes: file.size,
      }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the server. Check your connection.' };
  }

  if (signed.status === 501) {
    return {
      ok: false,
      error: 'File storage is not configured yet. Send the form without a file for now.',
    };
  }

  const body = await signed.json().catch(() => ({}));
  if (!signed.ok) {
    return { ok: false, error: body?.error ?? `Upload could not start (${signed.status}).` };
  }

  try {
    const put = await fetch(body.url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    if (!put.ok) {
      return { ok: false, error: `The upload was rejected (${put.status}).` };
    }
  } catch {
    return { ok: false, error: 'The upload failed part way. Try again on a steadier connection.' };
  }

  return { ok: true, key: body.key, isPublic: Boolean(body.public) };
}
