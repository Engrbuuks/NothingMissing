import { PRIVACY_VERSION } from '@/lib/legal';

export const metadata = { title: 'Privacy — Nothing Missing' };


export default function Privacy() {
  return (
    <section className="mkt-wrap legal">
      <span className="mkt-eyebrow">Privacy notice</span>
      <h1>Privacy</h1>
      <p className="legal-v">
        Version {PRIVACY_VERSION} · written to meet the Nigeria Data Protection Act 2023 and
        the NDPR
      </p>

      <h2>What we hold, and why</h2>
      <p>
        <b>Account holders.</b> Name, email address, and the companies and roles you hold.
        We need these to know who you are and what you may see.
      </p>
      <p>
        <b>Field link holders.</b> Name, role description and optionally a phone number,
        entered by the company that issued the link. These people have no account with us —
        the company that named them is the data controller, and we process on their
        instruction.
      </p>
      <p>
        <b>Activity.</b> Every action taken in a company&rsquo;s register, with the name of
        the person who took it and the time. This is the product, not a by-product: a record
        that cannot say who did something is not a record.
      </p>
      <p>
        <b>Technical.</b> Server logs containing IP addresses and request paths, kept for 30
        days for security and debugging.
      </p>

      <h2>What we do not do</h2>
      <p>
        We do not sell personal data. We do not use your register to train machine learning
        models. We do not place advertising or third-party tracking on the application.
      </p>

      <h2>Who processes it</h2>
      <p>
        Supabase (database and authentication, hosted on AWS), Vercel (application hosting),
        and Resend (transactional email) — each bound by their own processing terms. Data is
        stored outside Nigeria; where the Act requires it, transfers rely on the adequacy and
        contractual mechanisms those providers offer.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of everything we hold about you, correct it, or ask us to
        delete it. Signed-in users can export their own record from Settings immediately.
      </p>
      <p>
        <b>One honest limit.</b> Actions you took inside a company&rsquo;s register stay in
        that company&rsquo;s audit log even if you leave, and even if you ask us to remove
        them. That log is the basis of somebody else&rsquo;s asset register and may be needed
        in a dispute — the company is the controller of it, and we cannot erase it on an
        individual&rsquo;s request. Your name is retained; your account and contact details
        are not.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Registers and audit logs for as long as the company exists, and for 12 months after
        it closes. Account details until you delete your account. Server logs for 30 days.
      </p>

      <h2>Security</h2>
      <p>
        Every table is separated by the database rather than by our application code, so a
        bug in a query returns nothing rather than another company&rsquo;s data. Field link
        tokens are stored hashed. Passwords are handled by Supabase Auth and never reach us.
        Details are on the <a href="/security">security page</a>, including what we have not
        yet done.
      </p>

      <h2>Complaints</h2>
      <p>
        Write to us at hello@nothingmissing.ng. If we do not resolve it, you may complain to
        the Nigeria Data Protection Commission.
      </p>
    </section>
  );
}
