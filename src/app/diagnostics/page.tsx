import Shell from '@/components/Shell';
import { getSession, sb } from '@/lib/session';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

/**
 * A page that checks the wiring, so a broken connection reports itself instead
 * of surfacing as an empty table somewhere unrelated. Kept in the app rather
 * than in a script because the thing worth testing is what this app's session
 * can actually reach, not what a terminal can.
 */
export default async function Diagnostics() {
  const session = await getSession();
  const supabase = sb();
  const host = headers().get('x-tenant-host') ?? headers().get('host') ?? '';

  const checks: { label: string; ok: boolean; detail: string }[] = [];

  checks.push({
    label: 'Environment configured',
    ok: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    detail: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'NEXT_PUBLIC_SUPABASE_URL is not set',
  });

  // Does the schema exist at all? A failure here means the migrations were
  // never applied, and everything below will fail for the same reason.
  const { error: tableErr } = await supabase.from('companies').select('id').limit(1);
  checks.push({
    label: 'Schema applied',
    ok: !tableErr || !/does not exist|schema cache/i.test(tableErr.message),
    detail: tableErr
      ? /public\./.test(tableErr.message)
        // The give-away is "public." in the message: the tables exist, the
        // client is looking in the wrong schema.
        ? `${tableErr.message} — this says "public", but everything lives in the "app" schema. Add "app" under Settings → API → Exposed schemas in Supabase.`
        : `${tableErr.message} — run the migrations 0001 to 0010 in order`
      : 'app.companies is reachable',
  });

  // Tenant resolution runs unauthenticated on every request, so it is the one
  // most likely to be silently wrong.
  const { data: resolved, error: resolveErr } = await supabase.rpc('resolve_tenant', {
    p_host: host,
  });
  checks.push({
    label: 'Tenant resolves from host',
    ok: Boolean(resolved?.tenant),
    detail: resolveErr
      ? resolveErr.message
      : resolved?.tenant
        ? `${host} → ${resolved.name}`
        : `${host} matched no company (${resolved?.reason ?? 'unknown'}). On the apex this is correct.`,
  });

  checks.push({
    label: 'Signed in',
    ok: Boolean(session),
    detail: session ? `${session.email}` : 'no session',
  });

  checks.push({
    label: 'Membership found',
    ok: Boolean(session?.role),
    detail: session?.role
      ? `${session.role}, ${session.scopedLocationIds.length === 0 ? 'all locations' : session.scopedLocationIds.length + ' location(s)'}`
      : 'this account is not a member of this company',
  });

  const counts: { label: string; n: number | string }[] = [];
  for (const t of ['locations', 'assets', 'stock_items', 'transfers', 'audit_events']) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    counts.push({ label: t, n: error ? '—' : (count ?? 0) });
  }

  // The important one. If this ever returns a row, tenant isolation is broken
  // and nothing else about the system can be trusted.
  // --- branding, step by step -------------------------------------------
  // Colour and logo pass through four layers, and a failure in any one looks
  // identical from the outside: nothing changes. So each is checked separately.
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('brand_hex, accent_hex, theme_mode, logo_path, brand_source')
    .limit(1)
    .maybeSingle();
  const cmp = (company ?? {}) as any;

  const hasThemeColumns = !companyErr || !/theme_mode|column/i.test(companyErr.message);

  const resolvedBrand = resolved?.brand_hex ?? null;

  let logoReachable: boolean | null = null;
  const logoHref = cmp.logo_path
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/branding/${cmp.logo_path}`
    : null;
  if (logoHref) {
    try {
      const r = await fetch(logoHref, { method: 'HEAD', cache: 'no-store' });
      logoReachable = r.ok;
    } catch {
      logoReachable = false;
    }
  }

  const brandChecks = [
    {
      label: 'Migration 0020 applied',
      ok: hasThemeColumns,
      detail: hasThemeColumns
        ? 'The theme columns exist on app.companies'
        : 'theme_mode and accent_hex are missing — run migration 0020',
    },
    {
      label: 'A colour is stored',
      ok: Boolean(cmp.brand_hex),
      detail: cmp.brand_hex
        ? `${cmp.brand_hex} (${cmp.brand_source === 'chosen' ? 'chosen in Settings' : 'still the default'})`
        : 'No brand_hex on the company row',
    },
    {
      label: 'The colour reaches the page',
      ok: Boolean(resolvedBrand) && resolvedBrand === cmp.brand_hex,
      detail:
        resolvedBrand === cmp.brand_hex
          ? `resolve_tenant returns ${resolvedBrand}, which matches`
          : `resolve_tenant returns ${resolvedBrand ?? 'nothing'} but the company row says ${cmp.brand_hex ?? 'nothing'} — re-run migration 0020, which updates that function`,
    },
    {
      label: 'A logo is set',
      ok: Boolean(cmp.logo_path),
      detail: cmp.logo_path
        ? String(cmp.logo_path)
        : 'None uploaded yet — Settings → Your logo. Initials are shown instead.',
    },
    {
      label: 'The logo file is reachable',
      ok: logoReachable === true,
      detail:
        logoReachable === null
          ? 'Nothing to check until a logo is uploaded'
          : logoReachable
            ? 'The branding bucket serves it publicly'
            : 'The file did not load. The `branding` bucket must exist and be marked Public — see backend/STORAGE.md',
    },
  ];

  const { data: leak } = await supabase.from('companies').select('id, name, slug');
  const visibleCompanies = leak ?? [];

  return (
    <Shell current="diagnostics" title="Diagnostics" subtitle="What this session can actually reach">
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Connection</div>
            <div className="card-s">Each of these must pass before anything else works</div>
          </div>
        </div>
        <div style={{ padding: '4px 0' }}>
          {checks.map((c) => (
            <div
              key={c.label}
              style={{
                display: 'flex',
                gap: 12,
                padding: '13px 20px',
                borderBottom: '1px solid var(--line-2)',
                alignItems: 'flex-start',
              }}
            >
              <span className={`pill ${c.ok ? 'p-ok' : 'p-bad'}`} style={{ flex: 'none' }}>
                <span className="pd" />
                {c.ok ? 'Pass' : 'Fail'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  {c.detail}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Rows visible to you</div>
            <div className="card-s">
              After row-level security. Zero is a valid answer, not necessarily a fault.
            </div>
          </div>
        </div>
        <div className="tbl-wrap">
          <table style={{ minWidth: 0 }}>
            <tbody>
              {counts.map((c) => (
                <tr key={c.label}>
                  <td className="mono" style={{ fontSize: 12.5 }}>
                    {c.label}
                  </td>
                  <td style={{ fontWeight: 600 }}>{c.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Branding</div>
            <div className="card-s">Each step has to pass for a company&rsquo;s colour and logo to show</div>
          </div>
        </div>
        <div style={{ padding: '4px 0' }}>
          {brandChecks.map((c) => (
            <div key={c.label} style={{ display: 'flex', gap: 12, padding: '13px 20px',
                 borderBottom: '1px solid var(--line-2)', alignItems: 'flex-start' }}>
              <span className={`pill ${c.ok ? 'p-ok' : 'p-bad'}`} style={{ flex: 'none' }}>
                <span className="pd" />{c.ok ? 'Pass' : 'Fail'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.label}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
                  {c.detail}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`notice ${visibleCompanies.length > 1 ? 'bad' : ''}`}>
        <p>
          <b>Tenant isolation:</b> this session can see{' '}
          <b>
            {visibleCompanies.length} compan{visibleCompanies.length === 1 ? 'y' : 'ies'}
          </b>
          {visibleCompanies.length > 0 && (
            <> — {visibleCompanies.map((c: any) => c.name).join(', ')}</>
          )}
          .
          <br />
          {visibleCompanies.length > 1
            ? 'More than one is only correct if this account genuinely holds memberships in several. Otherwise row-level security is not doing its job and nothing else here can be trusted.'
            : 'One, or zero when signed out, is what it should be.'}
        </p>
      </div>
    </Shell>
  );
}
