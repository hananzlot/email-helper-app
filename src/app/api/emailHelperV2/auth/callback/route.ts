import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { exchangeCodeForTokens, signInOrCreateUser, storeGmailTokens } from '@/lib/auth';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { createSession } from '@/lib/session';

const STATE_SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_SALT || 'clearbox-state-secret';

function verifyNonce(nonce: string, signedCookie: string): boolean {
  const dotIdx = signedCookie.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const cookieNonce = signedCookie.slice(0, dotIdx);
  const cookieSig = signedCookie.slice(dotIdx + 1);
  if (cookieNonce !== nonce) return false;
  const expectedSig = createHmac('sha256', STATE_SECRET).update(cookieNonce).digest('hex');
  try {
    const a = Buffer.from(cookieSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');  // 'nonce.login' or 'nonce.add_account.userId'
  const error = searchParams.get('error');

  const origin = process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error)}`, origin)
    );
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/login?error=no_code', origin));
  }

  // Verify OAuth state nonce against signed cookie
  const nonceCookie = request.cookies.get('email_helper_oauth_nonce')?.value;
  if (!nonceCookie) {
    return NextResponse.redirect(new URL('/login?error=missing_state_cookie', origin));
  }

  // Parse state: nonce.login or nonce.add_account.userId
  const stateParts = state.split('.');
  if (stateParts.length < 2) {
    return NextResponse.redirect(new URL('/login?error=invalid_state', origin));
  }

  const stateNonce = stateParts[0];
  if (!verifyNonce(stateNonce, nonceCookie)) {
    return NextResponse.redirect(new URL('/login?error=state_mismatch', origin));
  }

  const flow = stateParts[1]; // 'login' or 'add_account'
  const isAddAccount = flow === 'add_account';

  try {
    const redirectUri = `${origin}/api/emailHelperV2/auth/callback`;

    // Exchange Google auth code for tokens + user info
    const { tokens, userInfo, gmailProfile } = await exchangeCodeForTokens(code, redirectUri);

    let userId: string;

    if (isAddAccount) {
      // Adding another Gmail account — userId comes from verified state
      userId = stateParts[2];
      if (!userId) {
        return NextResponse.redirect(new URL('/login?error=missing_user_id', origin));
      }

      // Guard: check if this email is already connected to a DIFFERENT user
      const admin = createSupabaseAdmin();
      const { data: existingAccount } = await admin
        .from(TABLES.GMAIL_ACCOUNTS)
        .select('user_id')
        .eq('email', gmailProfile.email)
        .eq('status', 'connected')
        .neq('user_id', userId)
        .limit(1)
        .single();

      if (existingAccount) {
        return NextResponse.redirect(
          new URL(`/dashboard?error=${encodeURIComponent(`${gmailProfile.email} is already connected to another account. Please disconnect it there first.`)}`, origin)
        );
      }
    } else {
      // Primary login flow — sign in or create user
      const { user } = await signInOrCreateUser(userInfo.email, userInfo.name);
      userId = user.id;
    }

    // Store Gmail tokens
    const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
    await storeGmailTokens(
      userId,
      gmailProfile.email,
      tokens.access_token!,
      tokens.refresh_token || null,
      expiresAt
    );

    // For primary login, set up the session
    if (!isAddAccount) {
      // Check if this is the user's first Gmail account
      const admin = createSupabaseAdmin();
      const { data: accounts } = await admin
        .from(TABLES.GMAIL_ACCOUNTS)
        .select('email')
        .eq('user_id', userId);

      const isFirstAccount = !accounts || accounts.length <= 1;

      if (isFirstAccount) {
        // Auto-set as primary account and active inbox
        await admin
          .from(TABLES.USER_PROFILES)
          .update({
            primary_account: gmailProfile.email,
            active_inboxes: [gmailProfile.email],
          })
          .eq('id', userId);

        await admin
          .from(TABLES.GMAIL_ACCOUNTS)
          .update({ is_primary: true, is_active_inbox: true })
          .eq('user_id', userId)
          .eq('email', gmailProfile.email);
      }

      // Create a signed session token stored server-side
      const signedSession = await createSession(userId, gmailProfile.email);

      const redirectUrl = new URL('/dashboard', origin);
      redirectUrl.searchParams.set('account', gmailProfile.email);

      const response = NextResponse.redirect(redirectUrl);
      // Signed session cookie — contains token.hmac, NOT the userId
      response.cookies.set('email_helper_session', signedSession, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
      });
      // Account cookie for UI display only (not used for auth)
      response.cookies.set('email_helper_account', gmailProfile.email, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      });
      // Clear legacy + nonce cookies
      response.cookies.set('email_helper_user_id', '', { httpOnly: true, maxAge: 0, path: '/' });
      response.cookies.set('email_helper_oauth_nonce', '', { httpOnly: true, maxAge: 0, path: '/' });

      return response;
    } else {
      // Adding an account — create new session with updated account
      const signedSession = await createSession(userId, gmailProfile.email);

      const redirectUrl = new URL('/dashboard', origin);
      redirectUrl.searchParams.set('account_added', gmailProfile.email);
      redirectUrl.searchParams.set('account', gmailProfile.email);
      const response = NextResponse.redirect(redirectUrl);
      response.cookies.set('email_helper_session', signedSession, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      });
      response.cookies.set('email_helper_account', gmailProfile.email, {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      });
      // Clear legacy + nonce cookies
      response.cookies.set('email_helper_user_id', '', { httpOnly: true, maxAge: 0, path: '/' });
      response.cookies.set('email_helper_oauth_nonce', '', { httpOnly: true, maxAge: 0, path: '/' });
      return response;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('Auth callback error:', errorMsg, err);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(errorMsg || 'Authentication failed')}`, origin)
    );
  }
}
