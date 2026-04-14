import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHmac } from 'crypto';
import { getGoogleAuthUrl } from '@/lib/auth';
import { GMAIL_SCOPES, DRIVE_SCOPE } from '@/lib/gmail';
import { validateSession } from '@/lib/session';
import { createSupabaseAdmin } from '@/lib/supabase-server';

function getStateSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET environment variable is required.');
  return secret;
}

function hashNonce(nonce: string): string {
  return createHmac('sha256', getStateSecret()).update(nonce).digest('hex');
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  let flow = searchParams.get('state') || 'login';
  let userId: string | null = null;

  // For add_account or drive_backup, resolve the current userId from session
  if (flow === 'add_account' || flow === 'drive_backup') {
    const sessionCookie = request.cookies.get('email_helper_session')?.value;
    const session = await validateSession(sessionCookie);
    userId = session?.userId || null;
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

  // Build state: nonce.flow or nonce.flow.userId
  const state = (flow === 'add_account' || flow === 'drive_backup') && userId
    ? `${nonce}.${flow}.${userId}`
    : `${nonce}.login`;

  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
  const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

  // Drive backup flow requests additional Drive scope + login_hint to target correct account
  const scopes = flow === 'drive_backup' ? [...GMAIL_SCOPES, DRIVE_SCOPE] : undefined;
  const loginHint = flow === 'drive_backup' ? searchParams.get('hint') || undefined : undefined;
  const authUrl = getGoogleAuthUrl(state, redirectUri, scopes, loginHint);
  return NextResponse.redirect(authUrl);
}
