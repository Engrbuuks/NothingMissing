import { TERMS_VERSION } from '@/lib/legal';

export const metadata = { title: 'Terms — Nothing Missing' };


export default function Terms() {
  return (
    <section className="mkt-wrap legal">
      <span className="mkt-eyebrow">Terms of service</span>
      <h1>Terms</h1>
      <p className="legal-v">Version {TERMS_VERSION} · governed by the laws of the Federal Republic of Nigeria</p>

      <h2>What we provide</h2>
      <p>
        Nothing Missing is software for recording where your assets and stock are, who moved
        them, and what happened to them. We provide the software. The records are yours, and
        their accuracy depends on what your people enter.
      </p>

      <h2>Your account</h2>
      <p>
        You are responsible for who you invite and what role you give them. An owner can see
        and do everything in their company, including reading the audit log — that is
        deliberate, and you should treat the owner role accordingly.
      </p>
      <p>
        Field links let people submit information without an account. Anything submitted
        through one is attributed to the person you named when issuing it. If a link is
        shared, submissions still carry that name, so revoke links when someone leaves.
      </p>

      <h2>What we will not do</h2>
      <p>
        We will not edit or delete entries in your audit log, and neither will you — the
        permission does not exist for anybody. If you need a correction, record a further
        event describing it. We would rather refuse a support request than break the one
        guarantee the product rests on.
      </p>
      <p>
        We do not sell your data, use it to train models, or share it with anyone except the
        infrastructure providers named in the privacy notice.
      </p>

      <h2>Payment</h2>
      <p>
        Pricing is per asset on your register, billed monthly. Companies on the free tier stay
        free below the published asset limit. If you stop paying we will tell you before
        anything is restricted, and your data remains available for export for at least 60
        days after an account lapses.
      </p>

      <h2>Ending it</h2>
      <p>
        You can close your company at any time from Settings. Closing archives it: field links
        are revoked immediately, your address is retired so nobody else can claim a URL whose
        links are still circulating, and the records are retained. Export your data before
        closing if you want a copy — we will also provide one on request.
      </p>

      <h2>Liability</h2>
      <p>
        We provide this software as it is. We do not guarantee it will be available without
        interruption, and we are not liable for losses arising from decisions made on the
        basis of records in it. It is a record of what people entered, not an independent
        verification that those entries were true.
      </p>
      <p>
        Where liability cannot be excluded by law, it is limited to the fees you paid in the
        twelve months before the claim.
      </p>

      <h2>Changes</h2>
      <p>
        If we change these terms materially we will tell you by email at least 30 days
        beforehand, and record which version you accepted and when. That record is why we
        version this page rather than quietly editing it.
      </p>

      <h2>Contact</h2>
      <p>hello@nothingmissing.ng · Lagos, Nigeria</p>
    </section>
  );
}
