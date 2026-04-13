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
  const { userId } = getRequestContext(request);
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
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json().catch(() => ({}));
  const { account_email } = body;
  if (!account_email) return apiError('Missing account_email');

  const admin = createSupabaseAdmin();

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
 * Processes ONE page per call, updates the job, returns status.
 */
export async function PUT(request: NextRequest) {
  const admin = createSupabaseAdmin();

  // Get the next pending job (or continue a processing one)
  let { data: job } = await admin
    .from(SYNC_QUEUE)
    .select('*')
    .eq('status', 'processing')
    .order('started_at', { ascending: true })
    .limit(1)
    .single();

  if (!job) {
    // No processing job — pick the next pending one
    const { data: pending } = await admin
      .from(SYNC_QUEUE)
      .select('*')
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('requested_at', { ascending: true })
      .limit(1)
      .single();

    if (!pending) return apiSuccess({ message: 'Queue empty', idle: true });

    // Mark as processing
    const { data: started } = await admin
      .from(SYNC_QUEUE)
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', pending.id)
      .select()
      .single();

    job = started || pending;
  }

  try {
    const accessToken = await getValidGmailToken(job.user_id, job.account_email);
    const gmail = getGmailClient(accessToken);

    // Get resume token from inbox_sync
    let pageToken: string | undefined;
    const { data: syncData } = await admin
      .from(TABLES.INBOX_SYNC)
      .select('resume_page_token')
      .eq('user_id', job.user_id)
      .eq('account_email', job.account_email)
      .single();

    if (syncData?.resume_page_token) pageToken = syncData.resume_page_token;

    // Get actioned IDs to skip
    const { data: actions } = await admin
      .from(TABLES.ACTION_HISTORY)
      .select('message_ids')
      .eq('user_id', job.user_id)
      .in('action', ['trash', 'archive', 'delete'])
      .eq('undone', false);
    const actionedSet = new Set<string>();
    if (actions) for (const r of actions) for (const mid of (r.message_ids || [])) actionedSet.add(mid);

    // Fetch one page
    const listRes = await listMessages(gmail, { query: 'in:inbox', maxResults: 100, pageToken });

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

      return apiSuccess({ jobId: job.id, status: 'done', totalCached: count || 0 });
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

    let inboxTotal = 0;
    try { inboxTotal = (await getLabelInfo(gmail, 'INBOX')).messagesTotal; } catch {}

    await admin.from(SYNC_QUEUE).update({
      pages_processed: (job.pages_processed || 0) + 1,
      messages_cached: (job.messages_cached || 0) + cachedThisPage,
      total_inbox: inboxTotal,
    }).eq('id', job.id);

    if (!nextPageToken) {
      await admin.from(SYNC_QUEUE).update({
        status: 'done', completed_at: new Date().toISOString(),
      }).eq('id', job.id);
    }

    return apiSuccess({
      jobId: job.id,
      status: nextPageToken ? 'processing' : 'done',
      cachedThisPage,
      skippedPages,
      pagesProcessed: (job.pages_processed || 0) + 1 + skippedPages,
      nextPageToken: !!nextPageToken,
    });
  } catch (err) {
    await admin.from(SYNC_QUEUE).update({
      status: 'error', error_message: String(err), completed_at: new Date().toISOString(),
    }).eq('id', job.id);
    return apiSuccess({ jobId: job.id, status: 'error', error: String(err) });
  }
}
