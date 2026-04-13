import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHmac } from 'crypto';
import { getGoogleAuthUrl } from '@/lib/auth';
import { validateSession } from '@/lib/session';

const STATE_SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_SALT || 'clearbox-state-secret';

function signNonce(nonce: string): string {
  return createHmac('sha256', STATE_SECRET).update(nonce).digest('hex');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let flow = searchParams.get('state') || 'login';
  let userId: string | null = null;

  // For add_account, resolve the current userId from session
  if (flow === 'add_account') {
    const sessionCookie = request.cookies.get('email_helper_session')?.value;
    const session = await validateSession(sessionCookie);
    userId = session?.userId || request.cookies.get('email_helper_user_id')?.value || null;
    if (!userId) {
      flow = 'login';
    }
  }

  // Generate a random nonce to prevent CSRF / state forgery
  const nonce = randomBytes(16).toString('hex');

  // Build state: nonce.flow or nonce.add_account.userId
  const state = flow === 'add_account' && userId
    ? `${nonce}.add_account.${userId}`
    : `${nonce}.login`;

  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

  const authUrl = getGoogleAuthUrl(state, redirectUri);
  const response = NextResponse.redirect(authUrl);

  // Store signed nonce in a short-lived httpOnly cookie for callback verification
  response.cookies.set('email_helper_oauth_nonce', `${nonce}.${signNonce(nonce)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600, // 10 minutes — OAuth flow should complete well within this
    path: '/',
  });

  return response;
}
