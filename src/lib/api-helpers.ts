import { NextRequest, NextResponse } from 'next/server';
import { getValidGmailToken } from './auth';
import { getGmailClient } from './gmail';
import { gmail_v1 } from 'googleapis';
import type { ApiResponse } from '@/types';
import { validateSession } from './session';

// In-memory session cache to avoid hitting Supabase on every API call.
// Key: signed cookie value, Value: { userId, accountEmail, cachedAt }
const sessionCache = new Map<string, { userId: string; accountEmail: string; cachedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Extract user ID and account email from the request.
 * Validates the HMAC-signed session token against the server-side sessions table.
 * Falls back to legacy cookie for migration period.
 */
export async function getRequestContext(request: NextRequest) {
  const sessionCookie = request.cookies.get('email_helper_session')?.value;

  if (sessionCookie) {
    // Check in-memory cache first
    const cached = sessionCache.get(sessionCookie);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      const account = request.nextUrl.searchParams.get('account')
        || request.cookies.get('email_helper_account')?.value
        || cached.accountEmail;
      return { error: null, userId: cached.userId, account };
    }

    // Validate signed session token against DB
    const session = await validateSession(sessionCookie);
    if (session) {
      // Cache the result
      sessionCache.set(sessionCookie, {
        userId: session.userId,
        accountEmail: session.accountEmail,
        cachedAt: Date.now(),
      });
      // Evict old entries periodically
      if (sessionCache.size > 1000) {
        const now = Date.now();
        for (const [key, val] of sessionCache) {
          if (now - val.cachedAt > CACHE_TTL_MS) sessionCache.delete(key);
        }
      }

      const account = request.nextUrl.searchParams.get('account')
        || request.cookies.get('email_helper_account')?.value
        || session.accountEmail;
      return { error: null, userId: session.userId, account };
    }
  }

  return { error: 'Not authenticated', userId: null, account: null };
}

/**
 * Get an authenticated Gmail client for the request.
 */
export async function getGmailFromRequest(
  request: NextRequest
): Promise<{ gmail: gmail_v1.Gmail; account: string } | { error: string }> {
  const { userId, account, error } = await getRequestContext(request);
  if (error || !userId || !account) {
    return { error: error || 'Missing account parameter' };
  }

  try {
    const accessToken = await getValidGmailToken(userId, account);
    const gmail = getGmailClient(accessToken);
    return { gmail, account };
  } catch (err) {
    console.error('Gmail auth failed:', err);
    return { error: 'Gmail auth failed' };
  }
}

/**
 * Standard API response helpers
 */
export function apiSuccess<T>(data: T): NextResponse<ApiResponse<T>> {
  return NextResponse.json({ success: true, data });
}

export function apiError(message: string, status = 400): NextResponse<ApiResponse> {
  return NextResponse.json({ success: false, error: message }, { status });
}
