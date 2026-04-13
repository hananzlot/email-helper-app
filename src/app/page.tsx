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

        {/* Unified inbox highlight */}
        <div className="mt-10 p-6 rounded-2xl" style={{ background: '#eef2ff', border: '1px solid #c7d2fe' }}>
          <div className="text-center">
            <div className="text-3xl mb-2">📬</div>
            <h3 className="text-lg font-bold mb-1" style={{ color: '#4338ca' }}>One inbox to rule them all</h3>
            <p className="text-sm" style={{ color: '#6366f1' }}>
              Connect all your Gmail accounts — work, personal, side projects — and manage them from a single unified view.
            </p>
            <div className="flex justify-center gap-3 mt-4">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: 'white', color: '#4338ca', border: '1px solid #c7d2fe' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Unlimited Gmail accounts
              </div>
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium" style={{ background: 'white', color: '#4338ca', border: '1px solid #c7d2fe' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Reply from the right account
              </div>
            </div>
            <p className="text-[10px] mt-3" style={{ color: '#a5b4fc' }}>Yahoo &amp; Outlook support coming soon</p>
          </div>
        </div>

        {/* Feature pillars */}
        <div className="mt-8 grid grid-cols-4 gap-4 text-center">
          <div className="p-4 rounded-xl" style={{ background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div className="text-2xl mb-1">🎯</div>
            <div className="text-sm font-bold" style={{ color: 'var(--accent)' }}>Top Tiers</div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>Smart sorting by who you reply to most</p>
          </div>
          <div className="p-4 rounded-xl" style={{ background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div className="text-2xl mb-1">🚀</div>
            <div className="text-sm font-bold" style={{ color: 'var(--accent)' }}>Easy-Clear</div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>Bulk-clean newsletters &amp; noise by domain</p>
          </div>
          <div className="p-4 rounded-xl" style={{ background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div className="text-2xl mb-1">⏰</div>
            <div className="text-sm font-bold" style={{ color: 'var(--accent)' }}>Follow Up</div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>Track emails waiting for a reply</p>
          </div>
          <div className="p-4 rounded-xl" style={{ background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
            <div className="text-2xl mb-1">🔍</div>
            <div className="text-sm font-bold" style={{ color: 'var(--accent)' }}>Smart Search</div>
            <p className="text-[10px] mt-1" style={{ color: 'var(--muted)' }}>Find any email across all accounts instantly</p>
          </div>
        </div>

        {/* Trust strip */}
        <div className="mt-8 pt-6 border-t" style={{ borderColor: 'var(--border)' }}>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="flex justify-center mb-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
              </div>
              <div className="text-lg font-bold" style={{ color: 'var(--text)' }}>100%</div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>Private — AES-256 encrypted</p>
            </div>
            <div>
              <div className="flex justify-center mb-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div className="text-lg font-bold" style={{ color: 'var(--text)' }}>30s</div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>Setup — just sign in</p>
            </div>
            <div>
              <div className="flex justify-center mb-1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              </div>
              <div className="text-lg font-bold" style={{ color: 'var(--text)' }}>1-click</div>
              <p className="text-[10px]" style={{ color: 'var(--muted)' }}>Undo any action</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
