import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient } from '@/lib/gmail';
import { scanSentMail, computeFollowUps } from '@/lib/triage';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/cron
 * Daily cron job: scans sent mail for all active users to update sender priorities.
 * Protected by CRON_SECRET header to prevent unauthorized access.
 *
 * Can be called by:
 * - Netlify scheduled function
 * - External cron service (e.g. cron-job.org, Upstash)
 * - Manual trigger with the secret header
 */
export async function GET(request: NextRequest) {
  // Verify cron secret to prevent unauthorized access
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createSupabaseAdmin();

  try {
    // Get all active Gmail accounts
    const { data: accounts, error: accountsError } = await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .select('user_id, email')
      .eq('status', 'connected');

    if (accountsError) {
      return NextResponse.json({ error: accountsError.message }, { status: 500 });
    }

    if (!accounts || accounts.length === 0) {
      return NextResponse.json({ message: 'No active accounts', scanned: 0 });
    }

    const results: { account: string; sendersFound: number; totalReplies: number; followUp?: { starred: number; awaiting: number }; error?: string }[] = [];

    // Process each account sequentially to avoid rate limits
    for (const account of accounts) {
      try {
        const accessToken = await getValidGmailToken(account.user_id, account.email);
        const gmail = getGmailClient(accessToken);

        // Scan sent mail for sender priorities
        const scanResult = await scanSentMail(gmail, account.user_id, account.email);

        // Pre-compute follow-up cache
        const followUpResult = await computeFollowUps(gmail, account.user_id, account.email);

        results.push({
          account: account.email,
          sendersFound: scanResult.sendersFound,
          totalReplies: scanResult.totalReplies,
          followUp: followUpResult,
        });
      } catch (err) {
        results.push({
          account: account.email,
          sendersFound: 0,
          totalReplies: 0,
          error: String(err),
        });
      }
    }

    const totalSenders = results.reduce((sum, r) => sum + r.sendersFound, 0);
    const totalReplies = results.reduce((sum, r) => sum + r.totalReplies, 0);

    return NextResponse.json({
      message: 'Cron complete',
      accountsProcessed: accounts.length,
      totalSenders,
      totalReplies,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
