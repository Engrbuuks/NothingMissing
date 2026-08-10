'use client';

import { useState } from 'react';
import { browser } from '@/lib/supabase';

/**
 * The receipt upload.
 *
 * The file goes straight from the browser to storage, and only the resulting
 * path is submitted with the form. A 5 MB photograph of a bank slip has no
 * business travelling through a server action — and the path is namespaced by
 * company, so a bucket policy can enforce the same separation the database
 * does.
 */
export default function ReceiptUpload({
  companyId,
  defaultAmount,
  action,
}: {
  companyId?: string;
  defaultAmount?: number;
  action: (formData: FormData) => Promise<void>;
}) {
  const supabase = browser();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !companyId) return;

    // Checked here for a quick answer, and again by the database. A browser
    // check is advice; a constraint is a rule.
    if (file.size > 10 * 1024 * 1024) {
      setError('That file is over 10 MB. A photo of the slip is plenty.');
      return;
    }
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
    if (!ok.includes(file.type)) {
      setError('Send a photo or a PDF of the transfer receipt.');
      return;
    }

    setBusy(true);
    setError(null);

    const key = `${companyId}/receipts/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
    const { error: upErr } = await supabase.storage
      .from('receipts')
      .upload(key, file, { cacheControl: '3600', upsert: false });

    if (upErr) {
      setError(
        /bucket/i.test(upErr.message)
          ? 'Receipt storage is not set up yet. Send the form without a file and email us the receipt.'
          : upErr.message
      );
      setBusy(false);
      return;
    }

    setPath(key);
    setName(file.name);
    setBusy(false);
  }

  return (
    <form action={action} style={{ padding: 20, display: 'grid', gap: 16 }}>
      <input type="hidden" name="receipt_path" value={path} />
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
        <input className="inp" id="receipt" type="file" onChange={upload}
               accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" />
        {busy && <div className="hint">Uploading…</div>}
        {path && (
          <div className="notice" style={{ marginTop: 10, marginBottom: 0 }}>
            <p><b>{name}</b> attached.</p>
          </div>
        )}
        <div className="hint">
          A screenshot from your banking app is fine. Without one we have to match the
          transfer by hand against the account, which takes longer.
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
