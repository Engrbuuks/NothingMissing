'use client';

import { useState } from 'react';
import { uploadFile } from '@/lib/upload-client';

export default function LogoUpload({
  current,
  publicBase,
  action,
}: {
  current: string | null;
  publicBase: string | null;
  action: (formData: FormData) => Promise<void>;
}) {
  const [key, setKey] = useState(current ?? '');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);

    const res = await uploadFile('branding', file);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }

    setKey(res.key);
    setPreview(URL.createObjectURL(file));
    setBusy(false);
  }

  const shown = preview ?? (key && publicBase ? `${publicBase}/${key.replace(/^branding\//, '')}` : null);

  return (
    <form action={action} style={{ padding: 20 }}>
      <input type="hidden" name="logo_path" value={key} />

      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="logo-slot">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="Your logo" />
          ) : (
            <span className="hint" style={{ textAlign: 'center' }}>No logo yet</span>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 220 }}>
          <input className="inp" type="file" onChange={onPick} disabled={busy}
                 accept="image/png,image/jpeg,image/webp,image/svg+xml" />
          <div className="hint">
            A wide logo with a transparent background works best — it sits in your sidebar at
            32px tall and on your waybills at about 44px. Under 2 MB.
          </div>
          {busy && <div className="hint">Uploading…</div>}
          {error && <div className="notice bad" style={{ marginTop: 10, marginBottom: 0 }}><p>{error}</p></div>}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn btn-p" type="submit" disabled={busy}>Save the logo</button>
        {key && (
          <button className="btn btn-g" type="submit" style={{ color: 'var(--bad)' }}
                  onClick={() => { setKey(''); setPreview(null); }}>
            Remove it
          </button>
        )}
      </div>
    </form>
  );
}
