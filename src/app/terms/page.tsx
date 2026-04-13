export default function TermsOfService() {
  return (
    <div className="px-4 sm:px-6 py-8 sm:py-12" style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <a href="/" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>
          &larr; Back to home
        </a>

        <h1 style={{ color: 'var(--text)', fontSize: 32, fontWeight: 700, marginTop: 24, marginBottom: 8 }}>
          Terms of Service
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 32 }}>
          Last updated: April 2026
        </p>

        <Section title="1. Acceptance of Terms">
          By accessing or using Clearbox (&quot;the Service&quot;), available at{' '}
          <a href="https://emaihelper.netlify.app" style={linkStyle}>emaihelper.netlify.app</a>,
          you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.
          Clearbox is currently in early/beta stage and features may change without notice.
        </Section>

        <Section title="2. Description of Service">
          <p style={paraStyle}>
            Clearbox is an email management tool that connects to your Gmail account(s) to help you
            triage, prioritize, clean up, and track follow-ups across your inboxes. The Service includes:
          </p>
          <ul style={listStyle}>
            <li>Inbox triage and sender prioritization</li>
            <li>Bulk email cleanup and organization</li>
            <li>AI-powered automated unsubscribe</li>
            <li>Follow-up and snooze tracking</li>
            <li>Multi-account unified inbox management</li>
          </ul>
        </Section>

        <Section title="3. Account and Access">
          <p style={paraStyle}>
            You sign in to Clearbox using your Google account via OAuth. By signing in, you grant
            Clearbox permission to access your Gmail data as described in our{' '}
            <a href="/privacy" style={linkStyle}>Privacy Policy</a>.
          </p>
          <p style={paraStyle}>
            You are responsible for maintaining the security of your Google account. You must not
            share your session or allow unauthorized access to the Service through your account.
          </p>
        </Section>

        <Section title="4. Permitted Use">
          <p style={paraStyle}>You agree to use Clearbox only for its intended purpose of managing your own email. You must not:</p>
          <ul style={listStyle}>
            <li>Use the Service to access email accounts you do not own or have authorization to manage</li>
            <li>Attempt to interfere with, disrupt, or overload the Service or its infrastructure</li>
            <li>Reverse-engineer, decompile, or attempt to extract the source code of the Service</li>
            <li>Use the Service for any unlawful purpose or in violation of any applicable laws</li>
            <li>Automate access to the Service beyond its intended interface</li>
          </ul>
        </Section>

        <Section title="5. Email Actions">
          <p style={paraStyle}>
            Clearbox can perform actions on your Gmail messages on your behalf, including archiving,
            marking as read/unread, labeling, trashing, and unsubscribing. These actions are taken
            only when you initiate them through the Clearbox interface.
          </p>
          <p style={paraStyle}>
            While we provide an undo feature for most actions, some actions (such as permanent deletion
            or third-party unsubscribe confirmations) may not be fully reversible. You are responsible
            for reviewing actions before confirming them.
          </p>
        </Section>

        <Section title="6. AI-Powered Unsubscribe">
          <p style={paraStyle}>
            The automated unsubscribe feature uses AI (Anthropic Claude) and a headless browser
            (Browserless.io) to visit unsubscribe pages and attempt to complete unsubscribe forms
            on your behalf. While we strive for accuracy:
          </p>
          <ul style={listStyle}>
            <li>Unsubscribe attempts may not always succeed due to varying website designs</li>
            <li>Some unsubscribe processes may require additional manual steps</li>
            <li>We are not responsible for the behavior of third-party unsubscribe pages</li>
          </ul>
        </Section>

        <Section title="7. Data and Privacy">
          <p style={paraStyle}>
            Your use of Clearbox is also governed by our <a href="/privacy" style={linkStyle}>Privacy Policy</a>,
            which describes how we collect, use, and protect your data. By using the Service, you
            consent to the practices described in the Privacy Policy.
          </p>
        </Section>

        <Section title="8. Beta Disclaimer">
          <p style={paraStyle}>
            Clearbox is currently in early/beta stage. The Service is provided on an &quot;as is&quot; and
            &quot;as available&quot; basis. We make no warranties, express or implied, regarding the reliability,
            availability, or accuracy of the Service. Features may be added, changed, or removed at any time.
          </p>
        </Section>

        <Section title="9. Limitation of Liability">
          <p style={paraStyle}>
            To the maximum extent permitted by law, Clearbox and its operators shall not be liable for
            any indirect, incidental, special, consequential, or punitive damages, including but not
            limited to loss of data, loss of emails, or missed communications, arising from your use
            of the Service.
          </p>
        </Section>

        <Section title="10. Account Disconnection">
          <p style={paraStyle}>
            You may disconnect any Gmail account from Clearbox at any time through the app settings.
            Disconnecting an account revokes the OAuth token and deletes all data associated with that
            account from our systems.
          </p>
          <p style={paraStyle}>
            We reserve the right to suspend or terminate access to the Service for any user who violates
            these Terms.
          </p>
        </Section>

        <Section title="11. Changes to Terms">
          <p style={paraStyle}>
            We may update these Terms of Service from time to time. Changes will be posted on this page
            with an updated revision date. Continued use of Clearbox after changes constitutes acceptance
            of the updated terms.
          </p>
        </Section>

        <Section title="12. Contact">
          <p style={paraStyle}>
            If you have questions about these Terms of Service, please reach out through the Clearbox
            application or contact us at the email provided in the app settings.
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ color: 'var(--text)', fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{title}</h2>
      <div style={{ color: 'var(--text)', fontSize: 14, lineHeight: 1.7 }}>{children}</div>
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
};

const paraStyle: React.CSSProperties = {
  marginBottom: 8,
};

const listStyle: React.CSSProperties = {
  paddingLeft: 20,
  marginBottom: 8,
};
