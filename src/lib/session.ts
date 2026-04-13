import { randomBytes, createHmac, createHash, timingSafeEqual } from 'crypto';
import { createSupabaseAdmin } from '@/lib/supabase-server';

const SESSION_TABLE = 'emailHelperV2_sessions';
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.ENCRYPTION_SALT || 'clearbox-session-secret-change-in-prod';
const SESSION_MAX_AGE_DAYS = 30;

/**
 * Generate a cryptographically random session token (32 bytes → 64 hex chars).
 */
function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * HMAC-sign a token so the cookie value is tamper-proof.
 * Cookie format: `token.signature`
 */
function signToken(token: string): string {
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(token)
    .digest('hex');
  return `${token}.${signature}`;
}

/**
 * Verify and extract the token from a signed cookie value.
 * Returns the raw token if valid, null if tampered.
 */
function verifySignedToken(signedValue: string): string | null {
  const dotIndex = signedValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const token = signedValue.slice(0, dotIndex);
  const providedSig = signedValue.slice(dotIndex + 1);

  const expectedSig = createHmac('sha256', SESSION_SECRET)
    .update(token)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    const a = Buffer.from(providedSig, 'hex');
    const b = Buffer.from(expectedSig, 'hex');
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  return token;
}

/**
 * Hash the token before storing in DB.
 * If the DB is compromised, attackers can't use the hashed values as session tokens.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new session for a user. Returns the signed cookie value.
 */
export async function createSession(userId: string, accountEmail: string): Promise<string> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const admin = createSupabaseAdmin();
  await admin.from(SESSION_TABLE).insert({
    token_hash: tokenHash,
    user_id: userId,
    account_email: accountEmail,
    expires_at: expiresAt,
  });

  return signToken(token);
}

/**
 * Validate a session cookie value. Returns { userId, accountEmail } if valid, null otherwise.
 */
export async function validateSession(
  signedValue: string | undefined
): Promise<{ userId: string; accountEmail: string } | null> {
  if (!signedValue) return null;

  // Step 1: Verify HMAC signature (prevents cookie tampering)
  const token = verifySignedToken(signedValue);
  if (!token) return null;

  // Step 2: Look up session in DB by token hash
  const tokenHash = hashToken(token);
  const admin = createSupabaseAdmin();
  const { data: session, error } = await admin
    .from(SESSION_TABLE)
    .select('user_id, account_email, expires_at')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !session) return null;

  // Step 3: Check expiry
  if (new Date(session.expires_at) < new Date()) {
    // Expired — clean it up
    await admin.from(SESSION_TABLE).delete().eq('token_hash', tokenHash);
    return null;
  }

  // Step 4: Update last_used_at (fire-and-forget, don't block the request)
  admin.from(SESSION_TABLE)
    .update({ last_used_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .then(() => {});

  return { userId: session.user_id, accountEmail: session.account_email };
}

/**
 * Invalidate a session (logout). Deletes the session row from DB.
 */
export async function invalidateSession(signedValue: string | undefined): Promise<void> {
  if (!signedValue) return;

  const token = verifySignedToken(signedValue);
  if (!token) return;

  const tokenHash = hashToken(token);
  const admin = createSupabaseAdmin();
  await admin.from(SESSION_TABLE).delete().eq('token_hash', tokenHash);
}

/**
 * Invalidate ALL sessions for a user (e.g., password change, security event).
 */
export async function invalidateAllSessions(userId: string): Promise<void> {
  const admin = createSupabaseAdmin();
  await admin.from(SESSION_TABLE).delete().eq('user_id', userId);
}
