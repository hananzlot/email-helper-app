import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAuthUrl } from '@/lib/auth';
import { validateSession } from '@/lib/session';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let state = searchParams.get('state') || 'login';

  // For add_account, attach the current userId from the session
  if (state === 'add_account') {
    const sessionCookie = request.cookies.get('email_helper_session')?.value;
    const session = await validateSession(sessionCookie);
    // Fallback to legacy cookie during migration
    const userId = session?.userId || request.cookies.get('email_helper_user_id')?.value;
    if (userId) {
      state = `add_account:${userId}`;
    } else {
      // Not logged in — fall back to regular login
      state = 'login';
    }
  }

  // Use NEXT_PUBLIC_APP_URL for the redirect URI — Netlify's request.url
  // returns internal deploy preview URLs which aren't registered with Google
  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

  const authUrl = getGoogleAuthUrl(state, redirectUri);
  return NextResponse.redirect(authUrl);
}
