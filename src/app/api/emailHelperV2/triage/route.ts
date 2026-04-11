import { NextRequest } from 'next/server';
import { getGmailFromRequest, getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { runTriage, scanSentMail } from '@/lib/triage';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

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

  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const action = body.action || 'triage';

    if (action === 'triage') {
      const result = await runTriage(gmail, userId, account);
      return apiSuccess(result);
    }

    if (action === 'scan_sent') {
      const result = await scanSentMail(gmail, userId, account);
      return apiSuccess(result);
    }

    return apiError(`Unknown action: ${action}`);
  } catch (err) {
    console.error('Triage error:', err);
    return apiError(`Triage failed: ${err}`, 500);
  }
}

/**
 * GET /api/emailHelperV2/triage?account=email
 * Returns the last triage result for this account
 */
export async function GET(request: NextRequest) {
  const { userId, account } = getRequestContext(request);
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

  return apiSuccess(data);
}
