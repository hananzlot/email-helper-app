import { CodeChallengeMethod } from 'google-auth-library';
import { createSupabaseServerClient, createSupabaseAdmin } from './supabase-server';
import { getOAuth2Client, GMAIL_SCOPES } from './gmail';
import { TABLES } from './tables';
import { encrypt, decrypt } from './crypto';

/**
 * Generate the Google OAuth URL that requests Gmail permissions.
 *
 * We use Google OAuth directly (not Supabase's Google provider) because
 * we need the Gmail API scopes + access to the raw access/refresh tokens.
 * After Google redirects back, we exchange the code, store the Gmail tokens
 * in our gmail_accounts table, and sign the user into Supabase.
 */
export function getGoogleAuthUrl(
  state?: string,
  redirectUri?: string,
  scopes?: string[],
  loginHint?: string,
  codeChallenge?: string,
) {
  const oauth2Client = getOAuth2Client(redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes || GMAIL_SCOPES,
    state: state || 'login',
    include_granted_scopes: true,
    ...(loginHint ? { login_hint: loginHint } : {}),
    ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 } : {}),
  });
}

/**
 * Exchange the authorization code from Google for tokens.
 * Returns the tokens + user info from Google.
 */
export async function exchangeCodeForTokens(code: string, redirectUri?: string, codeVerifier?: string) {
  const oauth2Client = getOAuth2Client(redirectUri);
  const { tokens } = await oauth2Client.getToken(
    codeVerifier ? { code, codeVerifier } : { code }
  );
  oauth2Client.setCredentials(tokens);

  // Get user info from Google
  const { google } = await import('googleapis');
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  // Get Gmail profile
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const { data: gmailProfile } = await gmail.users.getProfile({ userId: 'me' });

  return {
    tokens,
    userInfo: {
      email: userInfo.email!,
      name: userInfo.name || userInfo.email!,
      picture: userInfo.picture,
      sub: userInfo.id || null,  // Google's stable user ID — needed for RISC subject matching
    },
    gmailProfile: {
      email: gmailProfile.emailAddress!,
      messagesTotal: gmailProfile.messagesTotal,
      threadsTotal: gmailProfile.threadsTotal,
    },
  };
}

/**
 * Sign the user into Supabase using their Google email.
 * If they don't have an account yet, Supabase creates one.
 * We use the admin client to create/sign in users server-side.
 */
export async function signInOrCreateUser(email: string, name: string) {
  const admin = createSupabaseAdmin();

  // 1. Check if an auth user exists with this exact email
  let existingUser = null;
  try {
    const { data: lookupData } = await admin.auth.admin.getUserByEmail(email);
    if (lookupData?.user) existingUser = lookupData.user;
  } catch {
    // getUserByEmail throws when user not found — continue
  }

  // 2. If not found by email, check if this email is a connected Gmail account for an existing user
  if (!existingUser) {
    try {
      const { data: connectedAccount } = await admin
        .from(TABLES.GMAIL_ACCOUNTS)
        .select('user_id')
        .eq('email', email)
        .eq('status', 'connected')
        .limit(1)
        .single();

      if (connectedAccount?.user_id) {
        const { data: ownerData } = await admin.auth.admin.getUserById(connectedAccount.user_id);
        if (ownerData?.user) existingUser = ownerData.user;
      }
    } catch {
      // Not found in connected accounts either — continue to create
    }
  }

  // 3. Existing user found — return them (no magic link needed, we use cookie auth)
  if (existingUser) {
    return { user: existingUser, isNew: false, token: null };
  }

  // 4. No existing user found — create via Supabase Auth
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,  // true = "already confirmed" — skips sending confirmation email
      user_metadata: { full_name: name },
    });
    if (!error && data?.user) {
      return { user: data.user, isNew: true, token: null };
    }
    // If createUser returned an error, fall through to fallback
    console.error('createUser returned error:', error?.message);
  } catch (e) {
    console.error('createUser threw:', e);
  }

  // Fallback: Supabase Auth unavailable (mail service, rate limit, etc.)
  // Generate a UUID and create user profile directly — cookie auth only needs an ID
  const crypto = await import('crypto');
  const generatedId = crypto.randomUUID();
  await admin
    .from(TABLES.USER_PROFILES)
    .upsert({
      id: generatedId,
      email,
      full_name: name,
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    .then(({ error: upsertErr }: { error: { message: string } | null }) => { if (upsertErr) console.error('Profile upsert error:', upsertErr.message); });

  return { user: { id: generatedId, email }, isNew: true, token: null };
}

/**
 * Store Gmail OAuth tokens for a connected account.
 */
export async function storeGmailTokens(
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: Date | null,
  googleSub?: string | null
) {
  const admin = createSupabaseAdmin();

  // If no new refresh_token provided, preserve the existing one (already encrypted in DB)
  let encryptedRefreshToken: string | null = null;
  if (!refreshToken) {
    const { data: existing } = await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .select('refresh_token')
      .eq('user_id', userId)
      .eq('email', email)
      .single();
    // Keep the already-encrypted value as-is (don't double-encrypt)
    encryptedRefreshToken = existing?.refresh_token || null;
  } else {
    // New refresh token — encrypt it
    encryptedRefreshToken = encrypt(refreshToken, userId);
  }

  // Encrypt access token before storing
  const encryptedAccessToken = encrypt(accessToken, userId);

  const { data, error } = await admin
    .from(TABLES.GMAIL_ACCOUNTS)
    .upsert(
      {
        user_id: userId,
        email,
        access_token: encryptedAccessToken,
        refresh_token: encryptedRefreshToken,
        token_expires_at: expiresAt?.toISOString(),
        status: 'connected',
        updated_at: new Date().toISOString(),
        ...(googleSub ? { google_sub: googleSub } : {}),
      },
      { onConflict: 'user_id,email' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get stored Gmail tokens for a specific account.
 */
export async function getGmailTokens(userId: string, email: string) {
  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.GMAIL_ACCOUNTS)
    .select('*')
    .eq('user_id', userId)
    .eq('email', email)
    .single();

  if (error) return null;

  // Decrypt tokens (gracefully handles unencrypted legacy data)
  if (data) {
    data.access_token = decrypt(data.access_token, userId);
    data.refresh_token = decrypt(data.refresh_token, userId);
  }
  return data;
}

/**
 * Refresh an expired Gmail access token using the stored refresh token.
 */
export async function refreshGmailToken(userId: string, email: string) {
  const account = await getGmailTokens(userId, email);
  if (!account?.refresh_token) throw new Error('No refresh token available');

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: account.refresh_token });
  const { credentials } = await oauth2Client.refreshAccessToken();

  // Update stored tokens
  await storeGmailTokens(
    userId,
    email,
    credentials.access_token!,
    account.refresh_token, // Keep existing refresh token
    credentials.expiry_date ? new Date(credentials.expiry_date) : null
  );

  return credentials.access_token!;
}

/**
 * Get a valid Gmail access token for a user's account.
 * Automatically refreshes if expired.
 */
export async function getValidGmailToken(userId: string, email: string) {
  const account = await getGmailTokens(userId, email);
  if (!account) throw new Error(`Gmail account ${email} not found`);

  // Check if token is expired (with 5 min buffer)
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at) : null;
  const isExpired = expiresAt && expiresAt.getTime() < Date.now() + 5 * 60 * 1000;

  if (isExpired && account.refresh_token) {
    return refreshGmailToken(userId, email);
  }

  return account.access_token;
}
