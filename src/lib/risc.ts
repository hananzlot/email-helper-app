/**
 * Google Cross-Account Protection (RISC) handler.
 *
 * Receives Security Event Tokens (SETs) from Google when a user's account is
 * compromised, disabled, or has its sessions/tokens revoked. We respond by
 * deleting our stored Gmail tokens and invalidating active sessions, so an
 * attacker who has hijacked the Google account cannot continue using
 * Clearbox via cached refresh tokens.
 *
 * Spec: https://developers.google.com/identity/protocols/risc
 * Event schemas: https://schemas.openid.net/secevent/risc/event-type/
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createSupabaseAdmin } from './supabase-server';
import { TABLES } from './tables';

const GOOGLE_RISC_ISSUER = 'https://accounts.google.com';
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

// Lazy: cached across invocations within a single Node process so we don't
// re-fetch Google's JWKS on every event. jose handles its own internal cache + rotation.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!_jwks) _jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  return _jwks;
}

export const RISC_EVENT_TYPES = {
  SESSIONS_REVOKED: 'https://schemas.openid.net/secevent/risc/event-type/sessions-revoked',
  TOKENS_REVOKED: 'https://schemas.openid.net/secevent/risc/event-type/tokens-revoked',
  ACCOUNT_DISABLED: 'https://schemas.openid.net/secevent/risc/event-type/account-disabled',
  ACCOUNT_PURGED: 'https://schemas.openid.net/secevent/risc/event-type/account-purged',
  ACCOUNT_CREDENTIAL_CHANGE_REQUIRED:
    'https://schemas.openid.net/secevent/risc/event-type/account-credential-change-required',
  VERIFICATION: 'https://schemas.openid.net/secevent/risc/event-type/verification',
} as const;

interface RiscSubject {
  email?: string;
  sub?: string;
}

interface RiscEventClaim {
  subject?: RiscSubject;
  reason?: string;
  state?: string;
}

interface RiscPayload extends JWTPayload {
  events: Record<string, RiscEventClaim>;
}

export interface ParsedRiscEvent {
  jti: string;
  eventType: string;
  subject: RiscSubject;
  reason: string | null;
  state: string | null;
}

/**
 * Verify the JWT signature, issuer, and audience, then extract the single
 * event the SET carries. Throws on any verification failure.
 */
export async function verifyRiscJwt(jwt: string, expectedAudience: string): Promise<ParsedRiscEvent> {
  const { payload } = await jwtVerify<RiscPayload>(jwt, getJwks(), {
    issuer: GOOGLE_RISC_ISSUER,
    audience: expectedAudience,
  });

  if (!payload.jti) throw new Error('SET missing jti');
  if (!payload.events || typeof payload.events !== 'object') {
    throw new Error('SET missing events claim');
  }

  // SETs carry exactly one event per JWT (per RFC 8417 we accept multiple but Google sends one).
  const eventEntries = Object.entries(payload.events);
  if (eventEntries.length === 0) throw new Error('SET has no events');
  const [eventType, eventClaim] = eventEntries[0];

  return {
    jti: payload.jti,
    eventType,
    subject: eventClaim.subject || {},
    reason: eventClaim.reason ?? null,
    state: eventClaim.state ?? null,
  };
}

/**
 * Look up Clearbox accounts that match the SET subject. Prefer matching by
 * Google sub (stable, immutable); fall back to email if sub isn't stored yet
 * (legacy rows from before the google_sub column was added).
 */
async function findAffectedAccounts(subject: RiscSubject): Promise<{ user_id: string; email: string }[]> {
  const admin = createSupabaseAdmin();
  if (subject.sub) {
    const { data } = await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .select('user_id, email')
      .eq('google_sub', subject.sub);
    if (data && data.length > 0) return data;
  }
  if (subject.email) {
    const { data } = await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .select('user_id, email')
      .eq('email', subject.email);
    return data || [];
  }
  return [];
}

async function invalidateSessions(userId: string) {
  const admin = createSupabaseAdmin();
  await admin.from(TABLES.SESSIONS).delete().eq('user_id', userId);
}

async function deleteGmailAccount(userId: string, email: string) {
  const admin = createSupabaseAdmin();
  await admin.from(TABLES.GMAIL_ACCOUNTS).delete().eq('user_id', userId).eq('email', email);
}

async function purgeAllUserData(userId: string) {
  const admin = createSupabaseAdmin();
  // Delete every row keyed by user_id across our tables. Order doesn't matter
  // since we have no FK cascades; we just want everything gone.
  const tablesToPurge: string[] = [
    TABLES.SESSIONS,
    TABLES.GMAIL_ACCOUNTS,
    TABLES.SENDER_PRIORITIES,
    TABLES.NOTIFICATION_RULES,
    TABLES.TRIAGE_RESULTS,
    TABLES.REPLY_QUEUE,
    TABLES.CLEANUP_REPORTS,
    TABLES.FOLLOW_UP_CACHE,
    TABLES.ACTION_HISTORY,
    TABLES.INBOX_CACHE,
    TABLES.INBOX_SYNC,
    TABLES.SYNC_QUEUE,
    TABLES.UNSUBSCRIBE_LOG,
    TABLES.BACKUP_JOBS,
    TABLES.FEEDBACK,
    TABLES.USER_PROFILES,
  ];
  for (const t of tablesToPurge) {
    // Some tables key on `id` rather than `user_id`; the delete will simply
    // affect zero rows in those, which is fine.
    await admin.from(t).delete().eq('user_id', userId);
  }
}

/**
 * Apply the appropriate action for a verified RISC event. Idempotent at the
 * caller level via the jti replay table — this function assumes it's called
 * at most once per (jti, account).
 */
export async function applyRiscEvent(event: ParsedRiscEvent): Promise<{ affected: number; action: string }> {
  const accounts = await findAffectedAccounts(event.subject);
  if (accounts.length === 0) {
    return { affected: 0, action: 'no_matching_account' };
  }

  switch (event.eventType) {
    case RISC_EVENT_TYPES.SESSIONS_REVOKED:
    case RISC_EVENT_TYPES.ACCOUNT_CREDENTIAL_CHANGE_REQUIRED:
      // User logged out everywhere or changed their password — drop our sessions
      // so they're forced to sign in again. Keep stored tokens; the user can
      // re-auth without losing their connected-account data.
      for (const a of accounts) await invalidateSessions(a.user_id);
      return { affected: accounts.length, action: 'sessions_invalidated' };

    case RISC_EVENT_TYPES.TOKENS_REVOKED:
      // The user (or Google) revoked Clearbox's OAuth grant for this account.
      // Our stored refresh token is now dead — remove the account row + sessions.
      for (const a of accounts) {
        await invalidateSessions(a.user_id);
        await deleteGmailAccount(a.user_id, a.email);
      }
      return { affected: accounts.length, action: 'tokens_and_sessions_revoked' };

    case RISC_EVENT_TYPES.ACCOUNT_DISABLED:
      // Account was disabled (likely hijacked or terms violation). Treat as
      // hard revoke — drop tokens and sessions so an attacker can't continue
      // using cached credentials.
      for (const a of accounts) {
        await invalidateSessions(a.user_id);
        await deleteGmailAccount(a.user_id, a.email);
      }
      return { affected: accounts.length, action: 'account_disabled_revoked' };

    case RISC_EVENT_TYPES.ACCOUNT_PURGED:
      // The Google account was permanently deleted. Wipe everything we hold.
      for (const a of accounts) await purgeAllUserData(a.user_id);
      return { affected: accounts.length, action: 'all_user_data_purged' };

    case RISC_EVENT_TYPES.VERIFICATION:
      // Google's "did you receive this?" probe. Accept and do nothing.
      return { affected: 0, action: 'verification_acknowledged' };

    default:
      return { affected: 0, action: `ignored_unknown_event:${event.eventType}` };
  }
}

/**
 * Record the jti so a replay of the same event is a no-op. Returns true if
 * this is the first time we've seen this jti, false if it was already processed.
 */
export async function markJtiProcessed(event: ParsedRiscEvent): Promise<boolean> {
  const admin = createSupabaseAdmin();
  const { error } = await admin.from(TABLES.RISC_PROCESSED_JTIS).insert({
    jti: event.jti,
    event_type: event.eventType,
    subject_email: event.subject.email ?? null,
    subject_sub: event.subject.sub ?? null,
  });
  // Unique-constraint violation = duplicate; anything else = real error.
  if (error) {
    if (error.code === '23505') return false;
    throw error;
  }
  return true;
}
