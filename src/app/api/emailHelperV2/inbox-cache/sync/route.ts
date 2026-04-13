import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, listMessages, batchGetMessageMetadata, getLabelInfo } from '@/lib/gmail';
import { TABLES } from '@/lib/tables';

/**
 * POST /api/emailHelperV2/inbox-cache/sync
 *
 * Processes ONE page of inbox messages (up to 200) and returns the next page token.
 * Designed to be called repeatedly until done.
 *
 * Smart resume: if no pageToken provided, reads the saved resume_page_token
 * from inbox_sync table so it skips already-cached pages automatically.
 *
 * Body: { user_id, account_email, pageToken?: string, resume?: boolean }
 * Returns: { cachedThisPage, totalCached, inboxTotal, nextPageToken, done }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { account_email } = body;
    let { pageToken } = body;

    // Authenticate: session cookie (client) or CRON_SECRET bearer (cron/server)
    let user_id: string | null = null;
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
      // Cron caller — trust user_id from body
      user_id = body.user_id;
    } else {
      // Client caller — derive from session
      const { getRequestContext } = await import('@/lib/api-helpers');
      const ctx = await getRequestContext(request);
      user_id = ctx.userId;
    }

    if (!user_id || !account_email) {
      return NextResponse.json({ success: false, error: 'Not authenticated or missing account_email' }, { status: 401 });
    }

    const admin = createSupabaseAdmin();
    const accessToken = await getValidGmailToken(user_id, account_email);
    const gmail = getGmailClient(accessToken);

    // If pageToken is undefined (not provided), try to resume from where we left off
    // If pageToken is explicitly null, start from page 1 (check for new messages)
    if (pageToken === undefined) {
      const { data: syncData } = await admin
        .from(TABLES.INBOX_SYNC)
        .select('resume_page_token')
        .eq('user_id', user_id)
        .eq('account_email', account_email)
        .single();

      if (syncData?.resume_page_token) {
        pageToken = syncData.resume_page_token;
      }
    }

    // Fetch one page of message IDs
    const listRes = await listMessages(gmail, {
      query: 'in:inbox',
      maxResults: 100,
      pageToken: pageToken || undefined,
    });

    if (!listRes.messages?.length) {
      // No more messages — sync complete, clear resume token
      const { count } = await admin
        .from(TABLES.INBOX_CACHE)
        .select('gmail_id', { count: 'exact', head: true })
        .eq('user_id', user_id)
        .eq('account_email', account_email);

      await admin.from(TABLES.INBOX_SYNC).upsert({
        user_id, account_email,
        last_synced_at: new Date().toISOString(),
        total_cached: count || 0,
        resume_page_token: null, // Done — no resume needed
      }, { onConflict: 'user_id,account_email' });

      return NextResponse.json({ success: true, data: { cachedThisPage: 0, totalCached: count || 0, nextPageToken: null, done: true } });
    }

    const messageIds = listRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);

    // Check which are already cached
    const { data: existing } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id')
      .eq('user_id', user_id)
      .eq('account_email', account_email)
      .in('gmail_id', messageIds);

    const existingSet = new Set<string>();
    if (existing) existing.forEach((r: { gmail_id: string }) => existingSet.add(r.gmail_id));

    // Also exclude messages that were actioned (trashed/archived/deleted) per action history
    const { data: actionedRows } = await admin
      .from(TABLES.ACTION_HISTORY)
      .select('message_ids')
      .eq('user_id', user_id)
      .in('action', ['trash', 'archive', 'delete'])
      .eq('undone', false);
    const actionedSet = new Set<string>();
    if (actionedRows) {
      for (const row of actionedRows) {
        for (const mid of (row.message_ids || [])) actionedSet.add(mid);
      }
    }

    let newIds = messageIds.filter(id => !existingSet.has(id) && !actionedSet.has(id));
    let cachedThisPage = 0;
    let skippedPages = 0;

    // Fast-forward: if ALL messages on this page are cached, keep jumping pages
    // without fetching metadata (just get nextPageToken). Up to 50 jumps per call.
    let currentPageToken = listRes.nextPageToken || null;
    while (newIds.length === 0 && currentPageToken && skippedPages < 50) {
      skippedPages++;
      const skipRes = await listMessages(gmail, { query: 'in:inbox', maxResults: 100, pageToken: currentPageToken });
      if (!skipRes.messages?.length) { currentPageToken = null; break; }
      const skipIds = skipRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);
      const { data: skipExisting } = await admin
        .from(TABLES.INBOX_CACHE)
        .select('gmail_id')
        .eq('user_id', user_id)
        .eq('account_email', account_email)
        .in('gmail_id', skipIds);
      const skipExistingSet = new Set<string>();
      if (skipExisting) skipExisting.forEach((r: { gmail_id: string }) => skipExistingSet.add(r.gmail_id));
      newIds = skipIds.filter(id => !skipExistingSet.has(id) && !actionedSet.has(id));
      currentPageToken = skipRes.nextPageToken || null;
      if (newIds.length > 0) {
        // Found uncached messages — update messageIds for caching below
        messageIds.length = 0;
        messageIds.push(...skipIds);
        break;
      }
    }

    // Update the page token to where we actually are after fast-forwarding
    const finalNextPageToken = currentPageToken;

    if (newIds.length > 0) {
      // Batch fetch metadata (25 parallel to stay within timeout)
      const messages = await batchGetMessageMetadata(gmail, newIds, 10);

      const rows = messages.map(m => ({
        user_id,
        account_email,
        gmail_id: m.id,
        thread_id: m.threadId || null,
        sender: m.sender || '',
        sender_email: m.senderEmail || '',
        subject: m.subject || '',
        snippet: m.snippet || '',
        date: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
        is_unread: m.isUnread ?? true,
        label_ids: m.labelIds || [],
        cached_at: new Date().toISOString(),
      }));

      for (let i = 0; i < rows.length; i += 100) {
        await admin.from(TABLES.INBOX_CACHE)
          .upsert(rows.slice(i, i + 100), { onConflict: 'user_id,account_email,gmail_id' });
      }

      cachedThisPage = rows.length;
    }

    const nextPageToken = finalNextPageToken;

    // Get actual total cached count (efficient count query, no data transfer)
    const { count: actualCachedCount } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('account_email', account_email);

    // Save resume token + accurate count
    await admin.from(TABLES.INBOX_SYNC).upsert({
      user_id, account_email,
      last_synced_at: new Date().toISOString(),
      total_cached: actualCachedCount || 0,
      resume_page_token: nextPageToken,
    }, { onConflict: 'user_id,account_email' });

    // Get inbox total (cheap single API call)
    let inboxTotal = 0;
    try {
      const labelInfo = await getLabelInfo(gmail, 'INBOX');
      inboxTotal = labelInfo.messagesTotal;
    } catch {}

    return NextResponse.json({
      success: true,
      data: {
        cachedThisPage,
        skippedPages,
        skippedExisting: existingSet.size,
        totalCached: actualCachedCount || 0,
        inboxTotal,
        nextPageToken,
        done: !nextPageToken,
      },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
