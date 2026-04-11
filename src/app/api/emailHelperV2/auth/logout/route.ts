import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/emailHelperV2/auth/logout
 * Clears all session cookies and redirects to home page
 */
export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/', request.url));

  // Clear all session cookies
  response.cookies.set('email_helper_user_id', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  response.cookies.set('email_helper_account', '', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}
