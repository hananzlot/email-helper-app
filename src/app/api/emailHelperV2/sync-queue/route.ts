import { NextRequest, NextResponse } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, listMessages, batchGetMessageMetadata, getLabelInfo } from '@/lib/gmail';
import { TABLES } from '@/lib/tables';

const SYNC_QUEUE = 'emailHelperV2_sync_queue';

/**
 * GET /api/emailHelperV2/sync-queue
 * Returns sync status for the current user's accounts.
 */
export async function GET(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data } = await admin
    .from(SYNC_QUEUE)
    .select('*')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing', 'done'])
    .order('requested_at', { ascending: false })
    .limit(10);

  return apiSuccess(data || []);
}

/**
 * POST /api/emailHelperV2/sync-queue
 * Submit a sync request for an account. If one already exists (pending/processing), returns it.
 * Body: { account_email: string }
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json().catch(() => ({}));
  const { account_email } = body;
  if (!account_email) return apiError('Missing account_email');

  const admin = createSupabaseAdmin();

  // Clean up old done/error jobs for this account to prevent queue bloat
  await admin
    .from(SYNC_QUEUE)
    .delete()
    .eq('user_id', userId)
    .eq('account_email', account_email)
    .in('status', ['done', 'error']);

  // Check if there's already a pending/processing job
  const { data: existing } = await admin
    .from(SYNC_QUEUE)
    .select('*')
    .eq('user_id', userId)
    .eq('account_email', account_email)
    .in('status', ['pending', 'processing'])
    .limit(1)
    .single();

  if (existing) return apiSuccess(existing);

  // Create new sync job
  const { data: job, error } = await admin
    .from(SYNC_QUEUE)
    .insert({
      user_id: userId,
      account_email,
      status: 'pending',
      priority: 5,
    })
    .select()
    .single();

  if (error) return apiError(error.message, 500);
  return apiSuccess(job);
}

/**
 * PUT /api/emailHelperV2/sync-queue
 * Process the next job in the queue. Called by the scheduled function or manually.
 * Requires CRON_SECRET bearer auth (server-to-server) or valid user session.
 * Processes ONE page per call, updates the job, returns status.
 */
export async function PUT(request: NextRequest) {
  // Require authentication: CRON_SECRET for server callers, session for client
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let sessionUserId: string | null = null;
  if (!isCron) {
    const { userId } = await getRequestContext(request);
    if (!userId) return apiError('Not authenticated', 401);
    sessionUserId = userId;
  }

  const admin = createSupabaseAdmin();

  // Round-robin: pick pending jobs first (rotates across accounts), then continue processing ones
  // When authenticated via session (not cron), only process the user's own jobs
  let pendingQuery = admin.from(SYNC_QUEUE).select('*').eq('status', 'pending').order('priority', { ascending: true }).order('requested_at', { ascending: true }).limit(1);
  if (sessionUserId) pendingQuery = pendingQuery.eq('user_id', sessionUserId);
  let { data: job } = await pendingQuery.single();

  if (job) {
    // Mark as processing
    const { data: started } = await admin
      .from(SYNC_QUEUE)
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .select()
      .single();
    job = started || job;
  } else {
    // No pending — continue a processing one (single account remaining)
    let processingQuery = admin.from(SYNC_QUEUE).select('*').eq('status', 'processing').order('started_at', { ascending: true }).limit(1);
    if (sessionUserId) processingQuery = processingQuery.eq('user_id', sessionUserId);
    const { data: processing } = await processingQuery.single();
    if (!processing) return apiSuccess({ message: 'Queue empty', idle: true });
    job = processing;
  }

  try {
    const accessToken = await getValidGmailToken(job.user_id, job.account_email);
    const gmail = getGmailClient(accessToken);

    // Get resume token from inbox_sync (only if this job has already processed pages)
    let pageToken: string | undefined;
    if ((job.pages_processed || 0) > 0) {
      const { data: syncData } = await admin
        .from(TABLES.INBOX_SYNC)
        .select('resume_page_token')
        .eq('user_id', job.user_id)
        .eq('account_email', job.account_email)
        .single();

      if (syncData?.resume_page_token) pageToken = syncData.resume_page_token;
    } else {
      // Fresh sync job — clear any stale resume token so we start from the beginning
      await admin.from(TABLES.INBOX_SYNC).upsert({
        user_id: job.user_id, account_email: job.account_email,
        resume_page_token: null,
      }, { onConflict: 'user_id,account_email' });
    }

    // Get actioned IDs to skip
    const { data: actions } = await admin
      .from(TABLES.ACTION_HISTORY)
      .select('message_ids')
      .eq('user_id', job.user_id)
      .in('action', ['trash', 'archive', 'delete'])
      .eq('undone', false);
    const actionedSet = new Set<string>();
    if (actions) for (const r of actions) for (const mid of (r.message_ids || [])) actionedSet.add(mid);

    // Track Gmail API calls for adaptive client pacing
    let gmailCalls = 0;

    // Fetch one page
    const listRes = await listMessages(gmail, { query: 'in:inbox', maxResults: 100, pageToken });
    gmailCalls++;

    if (!listRes.messages?.length) {
      // Done
      const { count } = await admin
        .from(TABLES.INBOX_CACHE)
        .select('gmail_id', { count: 'exact', head: true })
        .eq('user_id', job.user_id)
        .eq('account_email', job.account_email);

      await admin.from(TABLES.INBOX_SYNC).upsert({
        user_id: job.user_id, account_email: job.account_email,
        last_synced_at: new Date().toISOString(), total_cached: count || 0,
        resume_page_token: null,
      }, { onConflict: 'user_id,account_email' });

      await admin.from(SYNC_QUEUE).update({
        status: 'done', completed_at: new Date().toISOString(),
        messages_cached: count || 0, total_inbox: count || 0,
      }).eq('id', job.id);

      return apiSuccess({ jobId: job.id, status: 'done', totalCached: count || 0, gmailCalls: 1 });
    }

    const messageIds = listRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);

    // Check existing + actioned
    const { data: existing } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id')
      .eq('user_id', job.user_id)
      .eq('account_email', job.account_email)
      .in('gmail_id', messageIds);
    const existingSet = new Set<string>();
    if (existing) existing.forEach((r: { gmail_id: string }) => existingSet.add(r.gmail_id));

    let newIds = messageIds.filter(id => !existingSet.has(id) && !actionedSet.has(id));
    let cachedThisPage = 0;
    let skippedPages = 0;

    // Fast-forward: if ALL messages on this page are cached, skip ahead (up to 50 pages)
    let currentPageToken = listRes.nextPageToken || null;
    while (newIds.length === 0 && currentPageToken && skippedPages < 50) {
      skippedPages++;
      const skipRes = await listMessages(gmail, { query: 'in:inbox', maxResults: 100, pageToken: currentPageToken });
      gmailCalls++;
      if (!skipRes.messages?.length) { currentPageToken = null; break; }
      const skipIds = skipRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);
      const { data: skipExisting } = await admin
        .from(TABLES.INBOX_CACHE).select('gmail_id')
        .eq('user_id', job.user_id).eq('account_email', job.account_email)
        .in('gmail_id', skipIds);
      const skipSet = new Set<string>();
      if (skipExisting) skipExisting.forEach((r: { gmail_id: string }) => skipSet.add(r.gmail_id));
      newIds = skipIds.filter(id => !skipSet.has(id) && !actionedSet.has(id));
      currentPageToken = skipRes.nextPageToken || null;
      if (newIds.length > 0) { messageIds.length = 0; messageIds.push(...skipIds); break; }
    }

    if (newIds.length > 0) {
      gmailCalls += newIds.length; // Each message is one getMessage call
      const messages = await batchGetMessageMetadata(gmail, newIds, 10);
      const rows = messages.map(m => ({
        user_id: job!.user_id, account_email: job!.account_email,
        gmail_id: m.id, thread_id: m.threadId || null,
        sender: m.sender || '', sender_email: m.senderEmail || '',
        subject: m.subject || '', snippet: m.snippet || '',
        date: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
        is_unread: m.isUnread ?? true, label_ids: m.labelIds || [],
        cached_at: new Date().toISOString(),
      }));
      for (let i = 0; i < rows.length; i += 100) {
        await admin.from(TABLES.INBOX_CACHE)
          .upsert(rows.slice(i, i + 100), { onConflict: 'user_id,account_email,gmail_id' });
      }
      cachedThisPage = rows.length;
    }

    const nextPageToken = currentPageToken;

    // Update sync + job
    await admin.from(TABLES.INBOX_SYNC).upsert({
      user_id: job.user_id, account_email: job.account_email,
      last_synced_at: new Date().toISOString(),
      resume_page_token: nextPageToken,
    }, { onConflict: 'user_id,account_email' });

    // Always get the real Gmail inbox total and actual cache count
    let inboxTotal = 0;
    try { inboxTotal = (await getLabelInfo(gmail, 'INBOX')).messagesTotal; gmailCalls++; } catch {}

    const { count: actualCached } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id', { count: 'exact', head: true })
      .eq('user_id', job.user_id)
      .eq('account_email', job.account_email);

    await admin.from(SYNC_QUEUE).update({
      pages_processed: (job.pages_processed || 0) + 1,
      messages_cached: Math.min(actualCached || 0, inboxTotal || (actualCached || 0)),
      total_inbox: inboxTotal,
    }).eq('id', job.id);

    if (!nextPageToken) {
      await admin.from(SYNC_QUEUE).update({
        status: 'done', completed_at: new Date().toISOString(),
      }).eq('id', job.id);
    } else {
      // Reset to pending with updated requested_at so this job goes to the back of the queue (round-robin)
      await admin.from(SYNC_QUEUE).update({ status: 'pending', requested_at: new Date().toISOString() }).eq('id', job.id);
    }

    return apiSuccess({
      jobId: job.id,
      status: nextPageToken ? 'processing' : 'done',
      cachedThisPage,
      skippedPages,
      pagesProcessed: (job.pages_processed || 0) + 1 + skippedPages,
      nextPageToken: !!nextPageToken,
      gmailCalls,
    });
  } catch (err) {
    const errMsg = String(err);
    const isQuotaError = errMsg.toLowerCase().includes('quota');

    if (isQuotaError) {
      // Quota errors are transient — reset to pending with a future requested_at so it retries after other accounts
      await admin.from(SYNC_QUEUE).update({
        status: 'pending',
        error_message: errMsg,
        requested_at: new Date(Date.now() + 60_000).toISOString(), // 1 min cooldown
      }).eq('id', job.id);
      return apiSuccess({ jobId: job.id, status: 'quota_retry', error: errMsg });
    }

    await admin.from(SYNC_QUEUE).update({
      status: 'error', error_message: errMsg, completed_at: new Date().toISOString(),
    }).eq('id', job.id);
    return apiSuccess({ jobId: job.id, status: 'error', error: errMsg });
  }
}
