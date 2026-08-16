import { createClient } from '@supabase/supabase-js';
import '../../globals.css';

export const dynamic = 'force-dynamic';

/**
 * The field page. No account, no password, no session — just a token in the URL.
 *
 * Everything it shows comes from app.link_context(), which takes the token and
 * returns only what belongs to that link's own location. It cannot query the
 * tables directly and should not be able to: anon is denied on all of them,
 * which is what stops a forwarded link becoming a window into the register.
 *
 * The count deliberately shows no quantities. A counter who can see what the
 * system expects will agree with it, and the count is then worthless. The
 * comparison happens on the reviewer's screen, never here.
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

  const lines: { sku: string; qty: number }[] = [];
  for (const [k, v] of formData.entries()) {
    if (k.startsWith('qty_') && String(v).trim() !== '') {
      // A blank box means "not counted", which is not the same as zero.
      // Forcing a number there manufactures a variance out of nothing.
      lines.push({ sku: k.slice(4), qty: Number(v) });
    }
  }

  const { error } = await anon().rpc('submit_from_link', {
    p_token: token,
    p_kind: kind,
    p_note: (formData.get('note') as string) || null,
    p_device: 'Web',
    p_lines: kind === 'count' ? lines : null,
    p_asset: (formData.get('asset') as string) || null,
    p_fault: (formData.get('fault') as string) || null,
  });

  const { redirect } = await import('next/navigation');
  redirect(
    error ? `/l/${token}?error=${encodeURIComponent(error.message)}` : `/l/${token}?sent=1`
  );
}

export default async function Field({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { sent?: string; error?: string };
}) {
  const { data: ctx } = await anon().rpc('link_context', { p_token: params.token });

  if (!ctx?.valid) {
    return (
      <main style={{ maxWidth: 520, margin: '0 auto', padding: '60px 20px' }}>
        <h1 style={{ fontSize: 22 }}>This link is no longer valid</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 12, lineHeight: 1.65 }}>
          It may have expired, been revoked, reached its monthly limit, or been copied
          incompletely. Ask your manager for a new one.
        </p>
        <p style={{ color: 'var(--text-3)', marginTop: 14, fontSize: 12.5, lineHeight: 1.6 }}>
          If you copied this address by hand, check nothing was cut off the end.
        </p>
      </main>
    );
  }

  const verbs: string[] = ctx.verbs ?? [];
  const runningLow: boolean = Boolean(ctx.running_low);
  const usedThisMonth: number = ctx.used_this_month ?? 0;
  const monthlyLimit: number | null = ctx.monthly_limit ?? null;
  const items: { sku: string; name: string; unit: string }[] = ctx.items ?? [];
  const assets: { id: string; tag: string; name: string }[] = ctx.assets ?? [];
  const can = (v: string) => verbs.includes(v);

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
            <a className="btn btn-g" href={`/l/${params.token}`} style={{ marginTop: 22 }}>
              Send something else
            </a>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      style={
        {
          maxWidth: 520,
          margin: '0 auto',
          padding: '32px 16px 60px',
          ['--brand' as string]: ctx.brand_hex ?? '#0551BD',
        } as React.CSSProperties
      }
    >
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', fontWeight: 600 }}>
          {ctx.company}
        </div>
        <h1 style={{ fontSize: 23, marginTop: 4 }}>
          {ctx.holder
            ? `Hello, ${String(ctx.holder).split(' ')[0]}`
            : 'What would you like to send?'}
        </h1>
        <p style={{ color: 'var(--text-3)', fontSize: 13.5, marginTop: 6 }}>
          {ctx.location} · anything you send goes to your manager to check first.
        </p>
      </div>

      {searchParams.error && (
        <div className="notice bad">
          <p>{searchParams.error}</p>
        </div>
      )}

      {/* Warned while it can still be acted on. A link that simply stops
          working mid-count teaches people the system is unreliable. */}
      {runningLow && monthlyLimit !== null && (
        <div className="notice warn">
          <p>
            <b>{monthlyLimit - usedThisMonth} submissions left this month.</b> It resets on
            the first. Tell your manager if you need more before then.
          </p>
        </div>
      )}

      {can('count') && (
        <form action={submit} className="card" style={{ marginBottom: 16 }}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="kind" value="count" />
          <div className="card-h bd">
            <div>
              <div className="card-t">Stock count</div>
              <div className="card-s">
                Count what is in front of you. Leave anything you could not reach blank —
                blank is not zero.
              </div>
            </div>
          </div>
          {items.length === 0 ? (
            <div className="empty">
              <h4>No stock items set up yet</h4>
              <p>
                Your company has not added any consumables to count. Ask your manager to add
                them first.
              </p>
            </div>
          ) : (
            <>
              {items.map((i) => (
                <div
                  key={i.sku}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '13px 18px',
                    borderBottom: '1px solid var(--line-2)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="aname">{i.name}</div>
                    <div className="amake">
                      <span className="tag">{i.sku}</span> · {i.unit}
                    </div>
                  </div>
                  <input
                    className="inp"
                    style={{ width: 110 }}
                    name={`qty_${i.sku}`}
                    type="number"
                    step="any"
                    min="0"
                    placeholder="—"
                    inputMode="decimal"
                  />
                </div>
              ))}
              <div style={{ padding: 18 }}>
                <input className="inp" name="note" placeholder="Anything your manager should know" />
                <div className="hint">
                  A variance with an explanation gets accepted. One without gets questioned.
                </div>
                <div style={{ height: 14 }} />
                <button className="btn btn-p" type="submit" style={{ width: '100%' }}>
                  Send the count
                </button>
              </div>
            </>
          )}
        </form>
      )}

      {can('fault') && (
        <form action={submit} className="card" style={{ marginBottom: 16 }}>
          <input type="hidden" name="token" value={params.token} />
          <input type="hidden" name="kind" value="fault" />
          <div className="card-h bd">
            <div>
              <div className="card-t">Report a fault</div>
              <div className="card-s">
                Your manager sees this straight away, with your name on it
              </div>
            </div>
          </div>
          {assets.length === 0 ? (
            <div className="empty">
              <h4>Nothing at this location yet</h4>
              <p>No assets are on the register here, so there is nothing to report against.</p>
            </div>
          ) : (
            <div style={{ padding: 18, display: 'grid', gap: 12 }}>
              <div>
                <label className="lbl" htmlFor="asset">
                  Which item
                </label>
                <select className="inp" id="asset" name="asset" required>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.tag} — {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="fault">
                  What is wrong
                </label>
                <select className="inp" id="fault" name="fault" required>
                  <option>Not working at all</option>
                  <option>Working, but faulty</option>
                  <option>Physically damaged</option>
                  <option>Missing from site</option>
                </select>
              </div>
              <div>
                <label className="lbl" htmlFor="note">
                  Describe it
                </label>
                <input
                  className="inp"
                  id="note"
                  name="note"
                  placeholder="What happened, and whether it is safe to leave as it is"
                />
              </div>
              <button className="btn btn-p" type="submit">
                Send the report
              </button>
            </div>
          )}
        </form>
      )}

      {!can('count') && !can('fault') && (
        <div className="card">
          <div className="empty">
            <h4>Nothing to do here</h4>
            <p>
              This link was not granted permission to submit anything. Ask your manager for
              one that is.
            </p>
          </div>
        </div>
      )}

      <p
        style={{
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--text-3)',
          marginTop: 24,
          lineHeight: 1.6,
        }}
      >
        Your name, the time and this device are recorded with everything you send.
      </p>
    </main>
  );
}
