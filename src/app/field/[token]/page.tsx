import { createClient } from '@supabase/supabase-js';
import '../../globals.css';

export const dynamic = 'force-dynamic';

/**
 * The field page. No account, no password, no session — just a token in the URL.
 *
 * It uses a bare anon client rather than the session-aware one on purpose:
 * whoever opens this is not signed in and never will be. Everything they can
 * do is bounded by app.submit_from_link(), which checks the token, the verbs
 * granted, and the location, and writes a pending row rather than a change.
 *
 * The count deliberately does NOT show the system figure. If it did, the
 * counter would agree with it and the count would be worthless.
 */
const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'app' }, auth: { persistSession: false } }
  );

async function submit(formData: FormData) {
  'use server';
  const token = String(formData.get('token'));
  const kind = String(formData.get('kind'));

  const lines = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('qty_') && String(v).trim() !== '') {
      lines.push({ sku: k.slice(4), qty: Number(v) });
    }
  }

  const { error } = await anon().rpc('submit_from_link', {
    p_token: token,
    p_kind: kind,
    p_note: (formData.get('note') as string) || null,
    p_device: 'Web',
    p_lines: lines.length ? lines : null,
    p_asset: (formData.get('asset') as string) || null,
    p_fault: (formData.get('fault') as string) || null,
  });

  const { redirect } = await import('next/navigation');
  redirect(error ? `/field/${token}?error=${encodeURIComponent(error.message)}` : `/field/${token}?sent=1`);
}

export default async function Field({
  params, searchParams,
}: { params: { token: string }; searchParams: { sent?: string; error?: string } }) {
  const supabase = anon();

  const { data: resolved } = await supabase.rpc('resolve_link', { p_token: params.token });
  const link = Array.isArray(resolved) ? resolved[0] : resolved;

  if (!link) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '60px 20px' }}>
        <h1 style={{ fontSize: 22 }}>This link is no longer valid</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          It may have expired, been revoked, or reached its limit. Ask your manager for a new one.
        </p>
      </main>
    );
  }

  if (searchParams.sent) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '48px 20px' }}>
        <div className="card">
          <div style={{ padding: 40, textAlign: 'center' }}>
            <h2 style={{ fontSize: 21, marginBottom: 12 }}>Sent for review</h2>
            <p style={{ color: 'var(--text-2)', lineHeight: 1.65 }}>
              Your manager has it now. Nothing on the register changes until they confirm
              it, and anything that differs from the system will be checked with you first.
            </p>
            <a className="btn btn-g" href={`/field/${params.token}`} style={{ marginTop: 22 }}>
              Send something else
            </a>
          </div>
        </div>
      </main>
    );
  }

  const { data: items } = await supabase
    .from('stock_items').select('sku, name, unit').is('archived_at', null).order('sku');

  const { data: assets } = await supabase
    .from('assets').select('id, tag, name').eq('location_id', link.location_id).order('tag');

  const can = (v: string) => (link.verbs ?? []).includes(v);

  return (
    <main style={{ maxWidth: 520, margin: '0 auto', padding: '32px 16px 60px' }}>
      <h1 style={{ fontSize: 23 }}>What would you like to send?</h1>
      <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 6 }}>
        Anything you send goes to your manager to check first.
      </p>

      {searchParams.error && <div className="notice bad" style={{ marginTop: 18 }}><p>{searchParams.error}</p></div>}

      {can('count') && (items ?? []).length > 0 && (
        <form action={submit} className="card" style={{ marginTop: 18 }}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="kind" value="count" />
          <div className="card-h bd">
            <div>
              <div className="card-t">Stock count</div>
              <div className="card-s">Count what is in front of you. Leave anything you could not reach blank — blank is not zero.</div>
            </div>
          </div>
          {(items ?? []).map((i: any) => (
            <div key={i.sku} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 18px', borderBottom: '1px solid var(--line-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="aname">{i.name}</div>
                <div className="amake"><span className="tag">{i.sku}</span> · {i.unit}</div>
              </div>
              <input className="inp" style={{ width: 110 }} name={`qty_${i.sku}`} type="number" step="any" min="0" placeholder="—" inputMode="decimal" />
            </div>
          ))}
          <div style={{ padding: 18 }}>
            <input className="inp" name="note" placeholder="Anything your manager should know" />
            <div className="hint">A variance with an explanation gets accepted. One without gets questioned.</div>
            <div style={{ height: 14 }} />
            <button className="btn btn-p" type="submit" style={{ width: '100%' }}>Send the count</button>
          </div>
        </form>
      )}

      {can('fault') && (assets ?? []).length > 0 && (
        <form action={submit} className="card" style={{ marginTop: 18 }}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="kind" value="fault" />
          <div className="card-h bd">
            <div>
              <div className="card-t">Report a fault</div>
              <div className="card-s">Your manager sees this straight away, with your name on it</div>
            </div>
          </div>
          <div style={{ padding: 18, display: 'grid', gap: 12 }}>
            <select className="inp" name="asset" required>
              {(assets ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.tag} — {a.name}</option>)}
            </select>
            <select className="inp" name="fault">
              <option>Not working at all</option>
              <option>Working, but faulty</option>
              <option>Physically damaged</option>
              <option>Missing from site</option>
            </select>
            <input className="inp" name="note" placeholder="What happened, and whether it is safe to leave" />
            <button className="btn btn-p" type="submit">Send the report</button>
          </div>
        </form>
      )}

      <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-3)', marginTop: 26, lineHeight: 1.6 }}>
        Your name, the time and this device are recorded with everything you send.
      </p>
    </main>
  );
}
