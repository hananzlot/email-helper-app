import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware: protect /dashboard, /admin, and /api/emailHelperV2/* routes.
 * Checks for the session cookie (or legacy cookie during migration).
 * Auth endpoints are excluded so login/callback/logout can work.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip auth routes (login, callback, logout) — they handle their own auth
  if (pathname.startsWith('/api/emailHelperV2/auth/')) return NextResponse.next();

  // Skip cron route — it uses CRON_SECRET bearer auth, not cookies
  if (pathname === '/api/emailHelperV2/cron') return NextResponse.next();

  // Skip unsubscribe route — it accepts CRON_SECRET bearer auth for server-to-server calls
  if (pathname === '/api/emailHelperV2/unsubscribe') return NextResponse.next();

  // Skip admin auth route — it verifies password server-side
  if (pathname === '/api/emailHelperV2/admin/auth') return NextResponse.next();

  // For protected routes, require the signed session cookie
  const hasSession = request.cookies.get('email_helper_session')?.value;

  if (!hasSession) {
    // API routes: return 401
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    // Page routes: redirect to login
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/admin/:path*',
    '/api/emailHelperV2/:path*',
  ],
};
