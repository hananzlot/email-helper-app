import { NextRequest, NextResponse } from 'next/server';
import { getValidGmailToken } from './auth';
import { getGmailClient } from './gmail';
import { gmail_v1 } from 'googleapis';
import type { ApiResponse } from '@/types';

/**
 * Extract user ID and account email from the request.
 * In production you'd validate a session token; for now we use cookies.
 */
export function getRequestContext(request: NextRequest) {
  const userId = request.cookies.get('email_helper_user_id')?.value;
  const account = request.nextUrl.searchParams.get('account')
    || request.cookies.get('email_helper_account')?.value;

  if (!userId) {
    return { error: 'Not authenticated', userId: null, account: null };
  }

  return { error: null, userId, account: account || null };
}

/**
 * Get an authenticated Gmail client for the request.
 */
export async function getGmailFromRequest(
  request: NextRequest
): Promise<{ gmail: gmail_v1.Gmail; account: string } | { error: string }> {
  const { userId, account, error } = getRequestContext(request);
  if (error || !userId || !account) {
    return { error: error || 'Missing account parameter' };
  }

  try {
    const accessToken = await getValidGmailToken(userId, account);
    const gmail = getGmailClient(accessToken);
    return { gmail, account };
  } catch (err) {
    return { error: `Gmail auth failed: ${err}` };
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
