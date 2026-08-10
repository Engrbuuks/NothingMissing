'use client';

import { useState } from 'react';
import { browser } from '@/lib/supabase';

/**
 * Logo upload. Straight from the browser to storage, so a large image never
 * travels through a server action, and the path is namespaced by company so a
 * bucket policy can enforce the same rule the database does.
 */
export default function LogoUpload({
  companyId,
  current,
  action,
}: {
  companyId: string;
  current: string | null;
  action: (formData: FormData) => Promise<void>;
}) {
  const supabase = browser();
  const [path, setPath] = useState(current ?? '');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setError('Keep it under 2 MB. A logo that big will slow every page it appears on.');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type)) {
      setError('PNG, JPEG, WebP or SVG.');
      return;
    }

    setBusy(true);
    setError(null);
    const key = `${companyId}/logo-${Date.now()}.${file.name.split('.').pop()}`;

    const { error: upErr } = await supabase.storage
      .from('branding')
      .upload(key, file, { upsert: true, cacheControl: '3600' });

    if (upErr) {
      setError(
        /bucket/i.test(upErr.message)
          ? 'Logo storage is not set up yet — see backend/STORAGE.md.'
          : upErr.message
      );
      setBusy(false);
      return;
    }

    setPath(key);
    setPreview(URL.createObjectURL(file));
    setBusy(false);
  }

  return (
    <form action={action} style={{ padding: 20 }}>
      <input type="hidden" name="logo_path" value={path} />

      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="logo-slot">
          {preview || path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={
                preview ??
                `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/branding/${path}`
              }
              alt="Your logo"
            />
          ) : (
            <span className="hint" style={{ textAlign: 'center' }}>No logo yet</span>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <input
            className="inp"
            type="file"
            onChange={upload}
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
          />
          <div className="hint">
            A wide logo with a transparent background works best — it sits in the sidebar at
            32px tall and on your waybills at about 44px. Under 2 MB.
          </div>
          {busy && <div className="hint">Uploading…</div>}
          {error && <div className="notice bad" style={{ marginTop: 10, marginBottom: 0 }}><p>{error}</p></div>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-p" type="submit" disabled={busy}>Save the logo</button>
        {path && (
          <button className="btn btn-g" type="submit" onClick={() => setPath('')}
                  style={{ color: 'var(--bad)' }}>
            Remove it
          </button>
        )}
      </div>
    </form>
  );
}
