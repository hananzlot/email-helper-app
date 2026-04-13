import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient } from '@/lib/gmail';
import { scanSentMail, computeFollowUps } from '@/lib/triage';
// Inbox caching is handled by the scheduled function via /inbox-cache/sync
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

  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
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

    // Clean inbox cache: remove entries for messages that were trashed/archived/deleted/read
    let cacheCleanedCount = 0;
    try {
      const { data: actions } = await admin
        .from(TABLES.ACTION_HISTORY)
        .select('message_ids')
        .in('action', ['trash', 'archive', 'delete'])
        .eq('undone', false);

      if (actions && actions.length > 0) {
        const allIds = new Set<string>();
        for (const row of actions) {
          for (const mid of (row.message_ids || [])) allIds.add(mid);
        }
        const idsArray = Array.from(allIds);
        // Delete in batches of 100
        for (let i = 0; i < idsArray.length; i += 100) {
          const batch = idsArray.slice(i, i + 100);
          await admin.from(TABLES.INBOX_CACHE).delete().in('gmail_id', batch);
        }
        cacheCleanedCount = idsArray.length;
      }
    } catch (e) {
      console.error('Cache cleanup failed:', e);
    }

    const totalSenders = results.reduce((sum, r) => sum + r.sendersFound, 0);
    const totalReplies = results.reduce((sum, r) => sum + r.totalReplies, 0);

    return NextResponse.json({
      message: 'Cron complete',
      accountsProcessed: accounts.length,
      totalSenders,
      totalReplies,
      cacheCleanedCount,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
