import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHmac } from 'crypto';
import { getGoogleAuthUrl } from '@/lib/auth';
import { validateSession } from '@/lib/session';
import { createSupabaseAdmin } from '@/lib/supabase-server';

const STATE_SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_SALT || 'clearbox-state-secret';

function hashNonce(nonce: string): string {
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

  // Store nonce hash server-side (survives cross-site redirects unlike cookies)
  const admin = createSupabaseAdmin();
  await admin.from('emailHelperV2_oauth_states').upsert({
    nonce_hash: hashNonce(nonce),
    flow,
    user_id: userId,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min
  }, { onConflict: 'nonce_hash' });

  // Build state: nonce.flow or nonce.add_account.userId
  const state = flow === 'add_account' && userId
    ? `${nonce}.add_account.${userId}`
    : `${nonce}.login`;

  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

  const authUrl = getGoogleAuthUrl(state, redirectUri);
  return NextResponse.redirect(authUrl);
}
