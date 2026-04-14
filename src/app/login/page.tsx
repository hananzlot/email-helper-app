'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Access was denied. Please try again.',
  no_code: 'Authentication failed. Please try again.',
  invalid_state: 'Session expired. Please try again.',
  invalid_or_expired_state: 'Session expired. Please try signing in again.',
  state_expired: 'Session expired. Please try signing in again.',
  state_mismatch: 'Security check failed. Please try again.',
  missing_user_id: 'Account linking failed. Please try again.',
};

function LoginContent() {
  const searchParams = useSearchParams();
  const rawError = searchParams.get('error');
  const error = rawError ? (ERROR_MESSAGES[rawError] || 'Something went wrong. Please try again.') : null;

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="max-w-md w-full mx-auto px-6 text-center">
        <img src="/clearbox-logo.svg" alt="Clearbox" width={64} height={64} className="rounded-xl mx-auto mb-3" />
        <h1 className="text-3xl font-bold mb-2">Clearbox</h1>

        {error ? (
          <div className="mb-6">
            <div className="p-4 rounded-xl mb-4" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
              <p className="text-sm font-medium" style={{ color: '#dc2626' }}>Sign in failed</p>
              <p className="text-xs mt-1" style={{ color: '#991b1b' }}>{error}</p>
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>
              Please try again. If this keeps happening, try a different Google account.
            </p>
          </div>
        ) : (
          <div className="mb-6">
            <p className="text-sm mb-3" style={{ color: 'var(--muted)' }}>
              Sign in to manage your inbox.
            </p>
            <div className="flex flex-col gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              <span>Smart triage, follow-ups, and one-click cleanup</span>
              <span>Backup your entire Gmail to your personal Google Drive</span>
              <span>Multi-account support with unified view</span>
            </div>
          </div>
        )}

        <a
          href="/api/emailHelperV2/auth/login"
          className="inline-flex items-center gap-3 px-8 py-3 rounded-xl font-semibold text-white transition-all hover:shadow-lg"
          style={{ background: '#4f46e5', fontSize: '16px' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Sign in with Google
        </a>

        <a href="/" className="block mt-4 text-xs underline" style={{ color: 'var(--muted)' }}>
          Return to home page
        </a>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center">Loading...</div>}>
      <LoginContent />
    </Suspense>
  );
}
