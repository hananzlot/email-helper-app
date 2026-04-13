export default function SecurityPage() {
  const auditDate = 'April 12, 2026';
  const sections = [
    {
      title: 'Authentication & Sessions',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      ),
      items: [
        'HMAC-signed session tokens with timing-safe verification — your session cannot be forged or tampered with',
        'Session tokens are hashed (SHA-256) before database storage — even a database breach cannot reveal active sessions',
        'Server-side session validation on every API request via Next.js middleware',
        'Sessions are invalidated on logout and can be revoked globally for security events',
        'OAuth login via Google with server-side nonce verification to prevent cross-site request forgery (CSRF)',
        'One-time-use OAuth state tokens with 10-minute expiry, stored server-side',
      ],
    },
    {
      title: 'Encryption',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      ),
      items: [
        'AES-256-GCM encryption for all sensitive data at rest — OAuth tokens, email content, subjects, and sender information',
        'Per-user encryption keys derived using HKDF-SHA256 — each user\u2019s data is encrypted with a unique key',
        'Encryption salt is a required environment variable — never hardcoded, never committed to source control',
        'Authenticated encryption (GCM) ensures data integrity — tampered ciphertext is detected and rejected',
        'HTTPS enforced everywhere with HSTS (Strict-Transport-Security) headers',
      ],
    },
    {
      title: 'Data Isolation',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      ),
      items: [
        'Every database query is scoped by authenticated user ID — one user can never access another\u2019s data',
        'Row-Level Security (RLS) enabled on all database tables as an additional enforcement layer',
        'Gmail API calls use per-user OAuth tokens scoped to the authenticated session',
        'Background sync jobs propagate user context correctly — no cross-user data mixing',
        'Complete data cleanup when disconnecting an account — tokens, cache, history, and logs are all purged',
      ],
    },
    {
      title: 'API Security',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      ),
      items: [
        'CSRF protection on all destructive endpoints via Origin header verification',
        'SSRF protection on all URL-fetching operations — private IPs, localhost, and internal ranges are blocked via DNS resolution checks',
        'Generic error messages returned to clients — internal details are logged server-side only, never exposed',
        'Input sanitization on email headers to prevent header injection attacks',
        'Field-level whitelisting on update endpoints to prevent unauthorized column modification',
        'Admin endpoints protected by server-side password verification with timing-safe comparison',
      ],
    },
    {
      title: 'OAuth & Gmail Permissions',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
      ),
      items: [
        'Least-privilege Gmail scopes: gmail.modify and gmail.readonly — no permanent delete capability',
        'OAuth refresh tokens encrypted at rest with per-user AES-256-GCM keys',
        'Tokens are revoked at Google when you disconnect an account — we don\u2019t retain access',
        'Access tokens are short-lived and automatically refreshed with a 5-minute buffer',
        'Clearbox never stores your Google password — authentication is handled entirely by Google\u2019s OAuth',
      ],
    },
    {
      title: 'Infrastructure',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
      ),
      items: [
        'Deployed on Netlify with automatic HTTPS and edge-level TLS termination',
        'All secrets stored in environment variables — never in source code or version control',
        'Security headers enforced: X-Frame-Options (DENY), X-Content-Type-Options (nosniff), Referrer-Policy, Permissions-Policy',
        'Zero known vulnerabilities in dependencies (npm audit clean)',
        '.env files excluded from version control via .gitignore — verified across full git history',
        'Background jobs (cron) protected by bearer token authentication',
      ],
    },
  ];

  return (
    <div style={{ background: 'var(--bg)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #3730a3 100%)', color: 'white', padding: '48px 24px 56px' }}>
        <div style={{ maxWidth: 800, margin: '0 auto', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 16 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
            <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Security at Clearbox</h1>
          </div>
          <p style={{ fontSize: 16, opacity: 0.85, maxWidth: 600, margin: '0 auto 24px', lineHeight: 1.6 }}>
            You trust Clearbox with access to your email. We take that trust seriously. Here is exactly how we protect your data.
          </p>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.12)', borderRadius: 9999, padding: '8px 20px', fontSize: 13, fontWeight: 600 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Independent security audit passed {auditDate}
          </div>
        </div>
      </div>

      {/* Audit summary bar */}
      <div style={{ maxWidth: 800, margin: '-28px auto 0', padding: '0 24px' }}>
        <div style={{ background: 'white', borderRadius: 16, boxShadow: '0 4px 24px rgba(0,0,0,0.08)', padding: '20px 28px', display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 16 }}>
          {[
            { value: '0', label: 'Critical issues', color: '#16a34a' },
            { value: '0', label: 'High issues', color: '#16a34a' },
            { value: 'AES-256', label: 'Encryption standard', color: '#4f46e5' },
            { value: '0', label: 'Known CVEs', color: '#16a34a' },
          ].map((s, i) => (
            <div key={i} style={{ textAlign: 'center', minWidth: 100 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sections */}
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 24px 64px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {sections.map((section, idx) => (
            <div key={idx} style={{ background: 'white', borderRadius: 16, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px 16px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ color: '#4f46e5', flexShrink: 0 }}>{section.icon}</div>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{section.title}</h2>
              </div>
              <ul style={{ padding: '16px 24px 20px', margin: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {section.items.map((item, j) => (
                  <li key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13.5, lineHeight: 1.55, color: '#334155' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Responsible disclosure */}
        <div style={{ marginTop: 40, background: '#f8fafc', borderRadius: 16, border: '1px solid #e2e8f0', padding: '24px 28px' }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Responsible Disclosure</h2>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: '#475569', margin: 0 }}>
            If you discover a security vulnerability, please report it to us privately so we can address it before public disclosure.
            Contact us at <strong>security@clearbox.app</strong>. We aim to acknowledge reports within 24 hours and resolve critical issues within 72 hours.
          </p>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 32, textAlign: 'center' }}>
          <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
            Last audited: {auditDate} &middot; Audit scope: full codebase review (OAuth, encryption, API routes, data isolation, infrastructure)
          </p>
          <a href="/" style={{ fontSize: 13, color: '#4f46e5', textDecoration: 'underline', marginTop: 8, display: 'inline-block' }}>
            Back to Clearbox
          </a>
        </div>
      </div>
    </div>
  );
}
