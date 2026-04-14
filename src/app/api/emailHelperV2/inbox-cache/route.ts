import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/inbox-cache?account=email
 * Returns cached inbox messages for instant load. If no account specified, returns all accounts.
 */
export async function GET(request: NextRequest) {
  const { userId, account } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const countOnly = request.nextUrl.searchParams.get('countOnly') === 'true';

  // Fast count-only mode — returns just the unread count, no message data
  if (countOnly) {
    const countQuery = admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_unread', true);
    if (account) countQuery.eq('account_email', account);
    const { count } = await countQuery;
    return apiSuccess({ unreadCount: count || 0, account: account || 'all' });
  }

  // Get actioned message IDs from history (trash/archive/delete) to exclude from results
  const { data: actions } = await admin
    .from(TABLES.ACTION_HISTORY)
    .select('message_ids')
    .eq('user_id', userId)
    .in('action', ['trash', 'archive', 'delete'])
    .eq('undone', false);

  const actionedIds = new Set<string>();
  if (actions) {
    for (const row of actions) {
      for (const mid of (row.message_ids || [])) actionedIds.add(mid);
    }
  }

  // Get sync metadata
  const syncQuery = admin
    .from(TABLES.INBOX_SYNC)
    .select('*')
    .eq('user_id', userId);
  if (account) syncQuery.eq('account_email', account);
  const { data: syncData } = await syncQuery;

  // Get cached messages
  const cacheQuery = admin
    .from(TABLES.INBOX_CACHE)
    .select('gmail_id, thread_id, sender, sender_email, subject, snippet, date, is_unread, label_ids, account_email')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1000);
  if (account) cacheQuery.eq('account_email', account);
  const { data: messages, error } = await cacheQuery;

  if (error) return apiError(error.message, 500);

  // Filter out actioned messages server-side
  const filtered = (messages || []).filter((m: { gmail_id: string }) => !actionedIds.has(m.gmail_id));

  return apiSuccess({
    messages: filtered,
    sync: syncData || [],
    cached: true,
  });
}

/**
 * POST /api/emailHelperV2/inbox-cache
 * Upsert a batch of messages into the cache.
 * Body: { account_email: string, messages: Array<{ id, threadId, sender, senderEmail, subject, snippet, date, isUnread, labelIds }> }
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { account_email, messages } = body;

    if (!account_email || !messages?.length) return apiError('Missing account_email or messages');

    const admin = createSupabaseAdmin();

    // Dedup: skip gmail_ids already cached under a different account for this user
    const incomingIds = messages.map((m: { id: string }) => m.id).filter(Boolean);
    const { data: alreadyCached } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id')
      .eq('user_id', userId)
      .neq('account_email', account_email)
      .in('gmail_id', incomingIds);
    const dupIds = new Set<string>();
    if (alreadyCached) alreadyCached.forEach((r: { gmail_id: string }) => dupIds.add(r.gmail_id));

    const dedupedMessages = messages.filter((m: { id: string }) => !dupIds.has(m.id));

    const rows = dedupedMessages.map((m: { id: string; threadId?: string; sender?: string; senderEmail?: string; subject?: string; snippet?: string; date?: string; isUnread?: boolean; labelIds?: string[] }) => ({
      user_id: userId,
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

    if (rows.length === 0) return apiSuccess({ cached: 0, skippedDuplicates: dupIds.size });

    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const { error } = await admin
        .from(TABLES.INBOX_CACHE)
        .upsert(chunk, { onConflict: 'user_id,account_email,gmail_id' });
      if (error) return apiError(error.message, 500);
    }

    // Update sync metadata
    const { error: syncError } = await admin
      .from(TABLES.INBOX_SYNC)
      .upsert({
        user_id: userId,
        account_email,
        last_synced_at: new Date().toISOString(),
        total_cached: rows.length,
      }, { onConflict: 'user_id,account_email' });

    if (syncError) return apiError(syncError.message, 500);

    return apiSuccess({ cached: rows.length });
  } catch (err) {
    console.error('Inbox cache POST failed:', err);
    return apiError('Operation failed', 500);
  }
}

/**
 * PUT /api/emailHelperV2/inbox-cache
 * Update cache entries (e.g. mark as read/unread).
 * Body: { gmail_ids: string[], updates: { is_unread?: boolean } }
 */
export async function PUT(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { gmail_ids, updates } = body;

    if (!gmail_ids?.length || !updates) return apiError('Missing gmail_ids or updates');

    // Whitelist allowed update fields to prevent arbitrary column modification
    const ALLOWED_FIELDS = new Set(['is_unread', 'label_ids', 'snippet', 'subject']);
    const safeUpdates: Record<string, unknown> = {};
    for (const key of Object.keys(updates)) {
      if (ALLOWED_FIELDS.has(key)) safeUpdates[key] = updates[key];
    }
    if (Object.keys(safeUpdates).length === 0) return apiError('No valid update fields');

    const admin = createSupabaseAdmin();
    const { error } = await admin
      .from(TABLES.INBOX_CACHE)
      .update(safeUpdates)
      .eq('user_id', userId)
      .in('gmail_id', gmail_ids);

    if (error) return apiError(error.message, 500);
    return apiSuccess({ updated: gmail_ids.length });
  } catch (err) {
    console.error('Inbox cache update failed:', err);
    return apiError('Update failed', 500);
  }
}

/**
 * DELETE /api/emailHelperV2/inbox-cache
 * Remove specific messages from cache (when archived/trashed/deleted).
 * Body: { account_email: string, gmail_ids: string[] }
 */
export async function DELETE(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { account_email, gmail_ids } = body;

    if (!gmail_ids?.length) return apiError('Missing gmail_ids');

    const admin = createSupabaseAdmin();
    const { error } = await admin
      .from(TABLES.INBOX_CACHE)
      .delete()
      .eq('user_id', userId)
      .eq('account_email', account_email)
      .in('gmail_id', gmail_ids);

    if (error) return apiError(error.message, 500);
    return apiSuccess({ deleted: gmail_ids.length });
  } catch (err) {
    console.error('Inbox cache DELETE failed:', err);
    return apiError('Operation failed', 500);
  }
}
