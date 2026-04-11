export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="max-w-lg w-full mx-auto px-6 text-center">
        {/* Problem-statement hook */}
        <p className="text-lg mb-4 font-medium" style={{ color: 'var(--muted)' }}>
          Drowning in unread emails?
        </p>

        <img src="/clearbox-logo.svg" alt="Clearbox" width={80} height={80} className="rounded-xl mx-auto mb-3" />
        <h1 className="text-4xl font-bold mb-2" style={{ color: 'var(--text)' }}>
          Clearbox
        </h1>
        <p className="text-sm mb-8" style={{ color: 'var(--muted)' }}>
          Your Inbox Command Center — triage, prioritize, and take control of your Gmail.
        </p>

        <a
          href="/api/emailHelperV2/auth/login"
          className="inline-flex items-center gap-3 px-8 py-3 rounded-xl font-semibold text-white transition-all hover:shadow-lg"
          style={{ background: 'var(--accent)', fontSize: '16px' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Sign in with Google
        </a>

        {/* Feature pillars */}
        <div className="mt-10 grid grid-cols-3 gap-6 text-center">
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>Triage</div>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Smart inbox sorting based on your reply patterns</p>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>Reply</div>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Prioritized reply queue with draft staging</p>
          </div>
          <div>
            <div className="text-2xl font-bold" style={{ color: 'var(--accent)' }}>Clean</div>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Archive newsletters, promos, and noise in bulk</p>
          </div>
        </div>

        {/* Social proof stats */}
        <div className="mt-10 pt-8 border-t" style={{ borderColor: 'var(--border)' }}>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="flex justify-center mb-1">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text)' }}>100%</div>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Private — emails never stored, AES-256 encrypted</p>
            </div>
            <div>
              <div className="flex justify-center mb-1">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text)' }}>30s</div>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Setup time — just sign in</p>
            </div>
            <div>
              <div className="flex justify-center mb-1">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </div>
              <div className="text-2xl font-bold" style={{ color: 'var(--text)' }}>1-click</div>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Undo any action instantly</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
