import { NextRequest, NextResponse } from 'next/server';
import { invalidateSession } from '@/lib/session';

/**
 * GET /api/emailHelperV2/auth/logout
 * Invalidates the server-side session and clears all cookies.
 */
export async function GET(request: NextRequest) {
  // Invalidate the session in the database
  const sessionCookie = request.cookies.get('email_helper_session')?.value;
  await invalidateSession(sessionCookie);

  const response = NextResponse.redirect(new URL('/', request.url));

  // Clear session cookie
  response.cookies.set('email_helper_session', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  // Clear legacy cookie
  response.cookies.set('email_helper_user_id', '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  // Clear account cookie
  response.cookies.set('email_helper_account', '', {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}
