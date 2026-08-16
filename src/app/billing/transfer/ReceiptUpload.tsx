'use client';

import { useState } from 'react';
import { uploadFile } from '@/lib/upload-client';

export default function ReceiptUpload({
  defaultAmount,
  action,
}: {
  defaultAmount?: number;
  action: (formData: FormData) => Promise<void>;
}) {
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);

    const res = await uploadFile('receipts', file);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    setKey(res.key);
    setName(file.name);
    setBusy(false);
  }

  return (
    <form action={action} style={{ padding: 20, display: 'grid', gap: 16 }}>
      <input type="hidden" name="receipt_path" value={key} />
      <input type="hidden" name="receipt_name" value={name} />

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
        <div>
          <label className="lbl" htmlFor="amount">Amount you sent</label>
          <input className="inp" id="amount" name="amount" required
                 defaultValue={defaultAmount?.toLocaleString('en-NG')} placeholder="e.g. 11,700" />
        </div>
        <div>
          <label className="lbl" htmlFor="paid_on">Date of the transfer</label>
          <input className="inp" id="paid_on" name="paid_on" type="date" required
                 max={new Date().toISOString().slice(0, 10)} />
        </div>
        <div>
          <label className="lbl" htmlFor="bank">Bank you sent from</label>
          <input className="inp" id="bank" name="bank" placeholder="GTBank, Zenith, Opay…" />
        </div>
      </div>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))' }}>
        <div>
          <label className="lbl" htmlFor="sender">Name on the sending account</label>
          <input className="inp" id="sender" name="sender" />
          <div className="hint">If it differs from your company name, this is what saves us asking.</div>
        </div>
        <div>
          <label className="lbl" htmlFor="narration">Narration you used</label>
          <input className="inp" id="narration" name="narration" />
        </div>
      </div>

      <div>
        <label className="lbl" htmlFor="receipt">Receipt</label>
        <input className="inp" id="receipt" type="file" onChange={onPick} disabled={busy}
               accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" />
        {busy && <div className="hint">Uploading…</div>}
        {key && (
          <div className="notice" style={{ marginTop: 10, marginBottom: 0 }}>
            <p><b>{name}</b> attached.</p>
          </div>
        )}
        <div className="hint">
          A screenshot from your banking app is fine. Without one we match the transfer by
          hand against the account, which takes longer.
        </div>
      </div>

      {error && <div className="notice bad" style={{ marginBottom: 0 }}><p>{error}</p></div>}

      <div>
        <button className="btn btn-p" type="submit" disabled={busy}>Record the transfer</button>
        <p className="hint" style={{ marginTop: 10 }}>
          Nothing is credited until we have checked it against the account. You will see it
          on the billing page as soon as it is confirmed.
        </p>
      </div>
    </form>
  );
}
