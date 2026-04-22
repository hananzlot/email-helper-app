export default function PrivacyPolicy() {
  return (
    <div className="px-4 sm:px-6 py-8 sm:py-12" style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <a href="/" style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 14, fontWeight: 500 }}>
          &larr; Back to home
        </a>

        <h1 style={{ color: 'var(--text)', fontSize: 32, fontWeight: 700, marginTop: 24, marginBottom: 8 }}>
          Privacy Policy
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 32 }}>
          Last updated: April 22, 2026
        </p>

        <Section title="1. Introduction">
          Clearbox (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates the email management application
          available at <a href="https://emaihelper.netlify.app" style={linkStyle}>emaihelper.netlify.app</a>.
          This Privacy Policy explains how we collect, use, and protect your information when you use our service.
          Clearbox is currently in early/beta stage.
        </Section>

        <Section title="2. Information We Collect">
          <p style={paraStyle}>When you sign in with Google, we access the following through the Gmail API:</p>
          <ul style={listStyle}>
            <li>Your email address and basic profile information</li>
            <li>Gmail messages (subject, sender, date, body content) for triage, prioritization, follow-up tracking, and cleanup features</li>
            <li>Sender information used to build your sender priority tiers</li>
          </ul>
          <p style={paraStyle}>We store the following data in our database (Supabase/PostgreSQL):</p>
          <ul style={listStyle}>
            <li>Cached inbox messages (subject, sender, snippet, labels, dates)</li>
            <li>Sender priorities and tier assignments</li>
            <li>Reply queue and follow-up tracking entries</li>
            <li>Action history (for undo functionality)</li>
            <li>Follow-up cache</li>
            <li>Unsubscribe log</li>
          </ul>
        </Section>

        <Section title="3. How We Use Your Information">
          <p style={paraStyle}>Your data is used exclusively to provide the Clearbox service:</p>
          <ul style={listStyle}>
            <li>Triaging and categorizing your inbox by sender priority</li>
            <li>Tracking emails awaiting replies (follow-up detection)</li>
            <li>Bulk cleanup and unsubscribe features</li>
            <li>Snoozing and queuing emails for later action</li>
            <li>Displaying your unified inbox across multiple connected Gmail accounts</li>
          </ul>
        </Section>

        <Section title="4. AI-Powered Features">
          <p style={paraStyle}>
            Clearbox uses the Anthropic Claude API to analyze unsubscribe pages and assist with
            automated unsubscription. When you use the AI auto-unsubscribe feature, the content of
            unsubscribe pages may be sent to Anthropic for analysis. We also use Browserless.io to
            visit unsubscribe pages on your behalf via a headless browser. No email body content is
            sent to these third-party AI or browser services for purposes other than unsubscribe processing.
          </p>
        </Section>

        <Section title="5. Data Storage and Security">
          <ul style={listStyle}>
            <li>OAuth tokens are encrypted at rest using AES-256-GCM encryption</li>
            <li>Session cookies are httpOnly, secure, and HMAC-signed</li>
            <li>All data is stored in Supabase (PostgreSQL) with row-level user isolation</li>
            <li>The application is hosted on Netlify with HTTPS enforced</li>
            <li>All database queries are filtered by authenticated user ID to ensure strict data isolation</li>
          </ul>
        </Section>

        <Section title="6. Third-Party Services">
          <p style={paraStyle}>We use the following third-party services to operate Clearbox:</p>
          <ul style={listStyle}>
            <li><strong>Google Gmail API</strong> — email access and management</li>
            <li><strong>Supabase</strong> — database storage and authentication</li>
            <li><strong>Anthropic Claude API</strong> — AI-powered unsubscribe page analysis</li>
            <li><strong>Browserless.io</strong> — headless browser for automated unsubscribe actions</li>
            <li><strong>Netlify</strong> — application hosting</li>
          </ul>
          <p style={paraStyle}>
            Each service processes data only as needed to provide its respective functionality.
            We do not sell, rent, or share your personal data with any third party for marketing or
            advertising purposes.
          </p>
        </Section>

        <Section title="7. Data Retention and Deletion">
          <p style={paraStyle}>
            You can disconnect any Gmail account from Clearbox at any time. When you disconnect an account,
            we revoke the OAuth token and delete all associated data for that account from our database.
          </p>
          <p style={paraStyle}>
            Cached inbox data is retained only while your account is connected and is used solely for
            providing the service.
          </p>
        </Section>

        <Section title="8. Your Rights">
          <ul style={listStyle}>
            <li>Disconnect any connected Gmail account at any time, which deletes all associated data</li>
            <li>Access your data through the Clearbox dashboard</li>
            <li>Request complete deletion of your account and all stored data by emailing <a href="mailto:chananzlot@gmail.com" style={linkStyle}>chananzlot@gmail.com</a></li>
          </ul>
        </Section>

        <Section title="9. Gmail Scopes and What Each One Is Used For">
          <p style={paraStyle}>
            Clearbox requests the minimum Gmail OAuth scopes required to deliver its features.
            Each scope is mapped to a specific functionality below:
          </p>
          <ul style={listStyle}>
            <li>
              <strong>https://www.googleapis.com/auth/gmail.modify</strong> — Used to archive,
              label, mark as read/unread, move to trash, send replies, and create drafts on your
              behalf. This scope is required because all of Clearbox&apos;s triage, queue, snooze,
              and cleanup actions involve modifying your inbox.
            </li>
            <li>
              <strong>https://www.googleapis.com/auth/gmail.readonly</strong> — Used to read
              message metadata (sender, subject, date, snippet) and full message bodies for
              triage, follow-up detection, sender prioritization, and the in-app preview.
            </li>
            <li>
              <strong>https://www.googleapis.com/auth/drive.file</strong> — Requested only when
              you explicitly trigger a Gmail backup. Limited to files Clearbox itself creates;
              we cannot read or modify any other files in your Drive.
            </li>
            <li>
              <strong>openid, email, profile</strong> — Standard sign-in scopes used to identify
              your account and display your name and avatar in the app.
            </li>
          </ul>
        </Section>

        <Section title="10. Google API Services User Data Policy &amp; Limited Use">
          <p style={paraStyle}>
            Clearbox&apos;s use and transfer of information received from Google APIs to any other
            app adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" style={linkStyle} target="_blank" rel="noopener noreferrer">
            Google API Services User Data Policy</a>, including the Limited Use requirements.
          </p>
          <p style={paraStyle}>Specifically, Clearbox affirms that it:</p>
          <ul style={listStyle}>
            <li>Only uses access to read, write, modify, or control Gmail message bodies, metadata, headers, and settings to provide a user-facing email management feature inside Clearbox.</li>
            <li>Does <strong>not</strong> transfer or sell Google user data to third parties for advertising, marketing, market research, or any unrelated purpose.</li>
            <li>Does <strong>not</strong> use Google user data to serve advertisements, including retargeted, personalized, or interest-based advertising.</li>
            <li>Does <strong>not</strong> allow humans to read Google user data unless the user provides affirmative consent for specific messages, it is necessary for security purposes (e.g. investigating abuse), to comply with applicable law, or for Clearbox&apos;s internal operations where the data has been aggregated and anonymized.</li>
            <li>Does <strong>not</strong> use Google user data to train, fine-tune, or improve generalized or non-personalized AI/ML models. AI features (e.g. AI-assisted unsubscribe) only process the specific page content needed for the requested action and do not feed back into model training.</li>
          </ul>
        </Section>

        <Section title="11. Revoking Access">
          <p style={paraStyle}>
            You can revoke Clearbox&apos;s access to your Google account at any time:
          </p>
          <ul style={listStyle}>
            <li>From inside Clearbox: open the Settings (⚙) menu → Accounts → click <em>Disconnect</em> next to the account. This revokes the OAuth token at Google and deletes all associated data from our database.</li>
            <li>From your Google account: visit <a href="https://myaccount.google.com/permissions" style={linkStyle} target="_blank" rel="noopener noreferrer">myaccount.google.com/permissions</a>, find &quot;Clearbox,&quot; and click <em>Remove access</em>.</li>
          </ul>
        </Section>

        <Section title="12. Account &amp; Data Deletion">
          <p style={paraStyle}>
            To request complete deletion of your account and every record we hold about you,
            email <a href="mailto:chananzlot@gmail.com" style={linkStyle}>chananzlot@gmail.com</a> from
            the Gmail address you use to sign in. We will permanently delete your data within 30 days
            and confirm by email when complete.
          </p>
        </Section>

        <Section title="13. Changes to This Policy">
          <p style={paraStyle}>
            We may update this Privacy Policy from time to time. Changes will be posted on this page
            with an updated revision date. Continued use of Clearbox after changes constitutes acceptance
            of the updated policy.
          </p>
        </Section>

        <Section title="14. Contact">
          <p style={paraStyle}>
            For any privacy-related question, request, or concern, contact us at{' '}
            <a href="mailto:chananzlot@gmail.com" style={linkStyle}>chananzlot@gmail.com</a>.
            We aim to respond within 5 business days.
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
