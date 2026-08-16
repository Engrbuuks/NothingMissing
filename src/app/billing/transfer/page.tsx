import Shell from '@/components/Shell';
import { sb, getSession, hasRole, money } from '@/lib/session';
import { submitPaymentProof } from '@/lib/actions';
import ReceiptUpload from './ReceiptUpload';

export const dynamic = 'force-dynamic';

export default async function TransferPage({
  searchParams,
}: { searchParams: { error?: string } }) {
  const session = await getSession();
  const supabase = sb();

  if (!hasRole(session, 'owner', 'admin')) {
    return (
      <Shell current="billing" title="Pay by transfer" subtitle="Bank details">
        <div className="card"><div className="empty"><h4>Not available to your role</h4>
        <p>Only an owner or admin can record a payment.</p></div></div>
      </Shell>
    );
  }

  const { data: co } = await supabase.from('companies').select('id, name').limit(1).maybeSingle();
  const { data: bank } = await supabase
    .from('platform_settings')
    .select('bank_name, account_name, account_number, instructions')
    .maybeSingle();
  const { data: b } = co
    ? await supabase.rpc('billing_summary', { p_company: (co as any).id })
    : { data: null };

  const owed = ((b ?? {}) as any).monthly_minor ?? 0;
  const bk = (bank ?? {}) as any;
  const configured = Boolean(bk.account_number);

  return (
    <Shell current="billing" title="Pay by transfer" subtitle="Send the money, then tell us">
      {searchParams.error && <div className="notice bad"><p>{searchParams.error}</p></div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-h bd">
          <div>
            <div className="card-t">Where to send it</div>
            <div className="card-s">Transfer from any Nigerian bank, then record it below</div>
          </div>
        </div>
        {configured ? (
          <div style={{ padding: 20 }}>
            <div className="bankbox">
              <div>
                <span className="wb-lbl">Bank</span>
                <b>{bk.bank_name}</b>
              </div>
              <div>
                <span className="wb-lbl">Account name</span>
                <b>{bk.account_name}</b>
              </div>
              <div>
                <span className="wb-lbl">Account number</span>
                <b className="mono" style={{ fontSize: 21, letterSpacing: '.06em' }}>
                  {bk.account_number}
                </b>
              </div>
              <div>
                <span className="wb-lbl">Amount due</span>
                <b className="mono" style={{ fontSize: 21 }}>{money(owed)}</b>
              </div>
            </div>
            <p className="hint" style={{ marginTop: 14 }}>
              Use your company name as the narration — <b>{(co as any)?.name}</b> — so we can
              match the transfer to your account without asking you.
            </p>
          </div>
        ) : (
          <div className="empty">
            <h4>Bank details are not set up yet</h4>
            <p>{bk.instructions ?? 'Email hello@nothingmissing.ng and we will invoice you directly.'}</p>
          </div>
        )}
      </div>

      {configured && (
        <div className="card">
          <div className="card-h bd">
            <div>
              <div className="card-t">Tell us you have paid</div>
              <div className="card-s">
                We check every transfer against the account before crediting it, which
                usually takes a few hours during the working day
              </div>
            </div>
          </div>
          <ReceiptUpload
            defaultAmount={owed > 0 ? Math.round(owed / 100) : undefined}
            action={submitPaymentProof}
          />
        </div>
      )}
    </Shell>
  );
}
