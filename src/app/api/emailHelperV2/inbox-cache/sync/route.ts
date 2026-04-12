import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, listMessages, batchGetMessageMetadata, getLabelInfo } from '@/lib/gmail';
import { TABLES } from '@/lib/tables';

/**
 * POST /api/emailHelperV2/inbox-cache/sync
 *
 * Processes ONE page of inbox messages (up to 200) and returns the next page token.
 * Designed to be called repeatedly until nextPageToken is null.
 * Each call fits within Netlify's 10s function timeout.
 *
 * Body: { user_id, account_email, pageToken?: string }
 * Returns: { cached, total, nextPageToken, done }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { user_id, account_email, pageToken } = body;

    if (!user_id || !account_email) {
      return NextResponse.json({ success: false, error: 'Missing user_id or account_email' }, { status: 400 });
    }

    const admin = createSupabaseAdmin();
    const accessToken = await getValidGmailToken(user_id, account_email);
    const gmail = getGmailClient(accessToken);

    // Get existing cached IDs for this page (to skip duplicates)
    const existingSet = new Set<string>();

    // Fetch one page of message IDs
    const listRes = await listMessages(gmail, {
      query: 'in:inbox',
      maxResults: 200,
      pageToken: pageToken || undefined,
    });

    if (!listRes.messages?.length) {
      // No more messages — update sync and return done
      const { count } = await admin
        .from(TABLES.INBOX_CACHE)
        .select('gmail_id', { count: 'exact', head: true })
        .eq('user_id', user_id)
        .eq('account_email', account_email);

      await admin.from(TABLES.INBOX_SYNC).upsert({
        user_id, account_email,
        last_synced_at: new Date().toISOString(),
        total_cached: count || 0,
      }, { onConflict: 'user_id,account_email' });

      return NextResponse.json({ success: true, data: { cached: 0, total: count || 0, nextPageToken: null, done: true } });
    }

    const messageIds = listRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);

    // Check which are already cached
    const { data: existing } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id')
      .eq('user_id', user_id)
      .eq('account_email', account_email)
      .in('gmail_id', messageIds);

    if (existing) existing.forEach((r: { gmail_id: string }) => existingSet.add(r.gmail_id));

    const newIds = messageIds.filter(id => !existingSet.has(id));
    let cachedThisPage = 0;

    if (newIds.length > 0) {
      // Batch fetch metadata (parallel — 25 at a time to stay within timeout)
      const messages = await batchGetMessageMetadata(gmail, newIds, 25);

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

    // Get total cached count
    const { count: totalCached } = await admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('account_email', account_email);

    // Get inbox total
    let inboxTotal = 0;
    try {
      const labelInfo = await getLabelInfo(gmail, 'INBOX');
      inboxTotal = labelInfo.messagesTotal;
    } catch {}

    return NextResponse.json({
      success: true,
      data: {
        cachedThisPage,
        totalCached: totalCached || 0,
        inboxTotal,
        nextPageToken: listRes.nextPageToken || null,
        done: !listRes.nextPageToken,
      },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
