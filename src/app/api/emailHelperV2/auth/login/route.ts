import { NextRequest, NextResponse } from 'next/server';
import { getGoogleAuthUrl } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let state = searchParams.get('state') || 'login';

  // For add_account, attach the current userId from the cookie
  if (state === 'add_account') {
    const userId = request.cookies.get('email_helper_user_id')?.value;
    if (userId) {
      state = `add_account:${userId}`;
    } else {
      // Not logged in — fall back to regular login
      state = 'login';
    }
  }

  // Use the current request origin for the redirect URI so branch deploys work
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

  const authUrl = getGoogleAuthUrl(state, redirectUri);
  return NextResponse.redirect(authUrl);
}
