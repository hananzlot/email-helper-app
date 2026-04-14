import { NextRequest } from 'next/server';
import { getGmailFromRequest, getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { runTriage, scanSentMail, computeFollowUps, DEFAULT_TIER_MINIMUMS } from '@/lib/triage';
import type { TierMinimums } from '@/lib/triage';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { decryptJson } from '@/lib/crypto';

/**
 * POST /api/emailHelperV2/triage
 * Body: { action: 'triage' | 'scan_sent' }
 *
 * triage: Run inbox triage — categorize unread emails by priority
 * scan_sent: Scan sent mail to learn sender priorities
 */
export async function POST(request: NextRequest) {
  const gmailResult = await getGmailFromRequest(request);
  if ('error' in gmailResult) return apiError(gmailResult.error, 401);
  const { gmail, account } = gmailResult;

  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const action = body.action || 'triage';

    if (action === 'triage') {
      const result = await runTriage(gmail, userId, account);
      // Also refresh follow-up cache in the background (don't block triage response)
      computeFollowUps(gmail, userId, account).catch(err => console.error('Follow-up cache refresh failed:', err));
      return apiSuccess(result);
    }

    if (action === 'scan_sent') {
      const tierMins: TierMinimums = body.tierMinimums || DEFAULT_TIER_MINIMUMS;
      const result = await scanSentMail(gmail, userId, account, tierMins);
      return apiSuccess(result);
    }

    if (action === 'compute_follow_ups') {
      const result = await computeFollowUps(gmail, userId, account);
      return apiSuccess(result);
    }

    return apiError(`Unknown action: ${action}`);
  } catch (err) {
    console.error('Triage error:', err);
    return apiError('Triage failed', 500);
  }
}

/**
 * GET /api/emailHelperV2/triage?account=email
 * Returns the last triage result for this account
 */
export async function GET(request: NextRequest) {
  const { userId, account } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);
  if (!account) return apiError('Missing account', 400);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.TRIAGE_RESULTS)
    .select('*')
    .eq('user_id', userId)
    .eq('account_email', account)
    .single();

  if (error || !data) {
    return apiSuccess({ exists: false, message: 'No triage results yet. Run a triage first.' });
  }

  // Decrypt the data field (may be encrypted JSON string or legacy JSONB object)
  if (data.data && typeof data.data === 'string') {
    data.data = decryptJson(data.data, userId);
  }

  return apiSuccess(data);
}

/**
 * GET /api/emailHelperV2/triage/follow-ups?account=email
 * Returns cached follow-up items for this account
 * (Handled in the main GET by checking for a 'type' param)
 */
