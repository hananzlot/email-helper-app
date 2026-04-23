/**
 * Google RISC (Cross-Account Protection) receiver.
 *
 * Google POSTs Security Event Tokens here when a Clearbox user's Google
 * account experiences a security event (sessions revoked, tokens revoked,
 * account disabled, account purged, credential change). We verify the JWT,
 * apply the appropriate action, and respond 202.
 *
 * Endpoint URL to register with Google:
 *   https://clearbox.pro/api/emailHelperV2/auth/risc
 *
 * Registration: see scripts/register-risc-receiver.md
 */
import { NextRequest, NextResponse } from 'next/server';
import { applyRiscEvent, markJtiProcessed, verifyRiscJwt } from '@/lib/risc';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 });
  }

  // Body is the raw JWT string (Content-Type: application/secevent+jwt).
  const jwt = (await request.text()).trim();
  if (!jwt) {
    return NextResponse.json({ error: 'empty_body' }, { status: 400 });
  }

  let event;
  try {
    event = await verifyRiscJwt(jwt, clientId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'verification_failed';
    // Use 400 so Google's RISC service knows the SET was malformed and won't keep retrying.
    return NextResponse.json({ error: 'invalid_jwt', detail: msg }, { status: 400 });
  }

  // Idempotency: skip if we've already handled this jti (Google may resend).
  let isNew: boolean;
  try {
    isNew = await markJtiProcessed(event);
  } catch (err) {
    // DB-side error — return 5xx so Google retries with backoff.
    const msg = err instanceof Error ? err.message : 'persistence_error';
    console.error('RISC: failed to record jti', { jti: event.jti, msg });
    return NextResponse.json({ error: 'persistence_error' }, { status: 503 });
  }

  if (!isNew) {
    return NextResponse.json({ status: 'already_processed', jti: event.jti }, { status: 202 });
  }

  try {
    const result = await applyRiscEvent(event);
    console.log('RISC event applied', { jti: event.jti, eventType: event.eventType, ...result });
    return NextResponse.json({ status: 'ok', ...result }, { status: 202 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'apply_failed';
    console.error('RISC: failed to apply event', { jti: event.jti, eventType: event.eventType, msg });
    return NextResponse.json({ error: 'apply_failed' }, { status: 503 });
  }
}
