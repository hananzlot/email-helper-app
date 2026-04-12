import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/inbox-cache?account=email
 * Returns cached inbox messages for instant load. If no account specified, returns all accounts.
 */
export async function GET(request: NextRequest) {
  const { userId, account } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();

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
    .limit(20000);
  if (account) cacheQuery.eq('account_email', account);
  const { data: messages, error } = await cacheQuery;

  if (error) return apiError(error.message, 500);

  return apiSuccess({
    messages: messages || [],
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
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { account_email, messages } = body;

    if (!account_email || !messages?.length) return apiError('Missing account_email or messages');

    const admin = createSupabaseAdmin();

    // Upsert messages in chunks of 500
    const rows = messages.map((m: { id: string; threadId?: string; sender?: string; senderEmail?: string; subject?: string; snippet?: string; date?: string; isUnread?: boolean; labelIds?: string[] }) => ({
      user_id: userId,
      account_email,
      gmail_id: m.id,
      thread_id: m.threadId || null,
      sender: m.sender || '',
      sender_email: m.senderEmail || '',
      subject: m.subject || '',
      snippet: m.snippet || '',
      date: m.date || new Date().toISOString(),
      is_unread: m.isUnread ?? true,
      label_ids: m.labelIds || [],
      cached_at: new Date().toISOString(),
    }));

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
    return apiError(`Failed: ${err}`, 500);
  }
}

/**
 * DELETE /api/emailHelperV2/inbox-cache
 * Remove specific messages from cache (when archived/trashed/deleted).
 * Body: { account_email: string, gmail_ids: string[] }
 */
export async function DELETE(request: NextRequest) {
  const { userId } = getRequestContext(request);
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
    return apiError(`Failed: ${err}`, 500);
  }
}
