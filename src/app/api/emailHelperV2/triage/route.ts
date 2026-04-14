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

      const admin = createSupabaseAdmin();

      // Clean up gibberish senders from DB (local part > 30 chars, UUIDs, bounce, noreply, etc.)
      const { data: allSenders } = await admin
        .from(TABLES.SENDER_PRIORITIES)
        .select('sender_email')
        .eq('user_id', userId);
      if (allSenders) {
        const gibberishEmails = allSenders
          .map((s: { sender_email: string }) => s.sender_email)
          .filter((email: string) => {
            const local = email.split('@')[0];
            const domain = email.split('@')[1] || '';
            if (local.length > 30) return true;
            if (/[0-9a-f]{8,}-[0-9a-f]{4,}/i.test(local)) return true;
            if (/noreply|no-reply|donotreply|do-not-reply|mailer-daemon/i.test(local)) return true;
            if (/^bounce/i.test(local) || /^bounce\./i.test(domain)) return true;
            if (/amazonses\.com|sendgrid\.net|mailgun\.org|mandrillapp\.com|postmarkapp\.com|constantcontact\.com|mailchimp\.com/i.test(domain)) return true;
            return false;
          });
        for (let i = 0; i < gibberishEmails.length; i += 50) {
          await admin.from(TABLES.SENDER_PRIORITIES).delete()
            .eq('user_id', userId)
            .in('sender_email', gibberishEmails.slice(i, i + 50));
        }
        if (gibberishEmails.length > 0) {
          console.log(`[scan_sent] Cleaned up ${gibberishEmails.length} gibberish senders for user ${userId}`);
        }
      }

      // Clean up queue: remove active entries for senders now below signal tier (D or untiered)
      const { data: dTierSenders } = await admin
        .from(TABLES.SENDER_PRIORITIES)
        .select('sender_email')
        .eq('user_id', userId)
        .eq('tier', 'D');
      if (dTierSenders && dTierSenders.length > 0) {
        const dEmails = dTierSenders.map((s: { sender_email: string }) => s.sender_email.toLowerCase());
        // Delete active queue items for D-tier senders (they belong in Easy-Clear now)
        for (let i = 0; i < dEmails.length; i += 50) {
          await admin.from(TABLES.REPLY_QUEUE).delete()
            .eq('user_id', userId)
            .eq('status', 'active')
            .in('sender_email', dEmails.slice(i, i + 50));
        }
      }

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
