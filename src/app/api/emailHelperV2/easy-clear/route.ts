import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

const COMMON_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'protonmail.com', 'mail.com',
]);

/**
 * GET /api/emailHelperV2/easy-clear?limit=50&offset=0&groupBy=domain
 * Returns pre-grouped noise emails from cache using SQL aggregation.
 * All filtering, deduplication, and grouping happens server-side.
 */
export async function GET(request: NextRequest) {
  const { userId, account } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
  const offset = parseInt(request.nextUrl.searchParams.get('offset') || '0');
  const groupBy = request.nextUrl.searchParams.get('groupBy') || 'domain';

  const admin = createSupabaseAdmin();

  // Get sender tiers (A/B/C senders are NOT noise — exclude them)
  const { data: senders } = await admin
    .from(TABLES.SENDER_PRIORITIES)
    .select('sender_email, tier')
    .eq('user_id', userId)
    .in('tier', ['A', 'B', 'C']);

  const signalSenders = new Set<string>();
  if (senders) {
    for (const s of senders) signalSenders.add(s.sender_email.toLowerCase());
  }

  // Get actioned message IDs to exclude
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

  // Fetch ALL unread messages in batches of 1000 (Supabase default limit)
  let allMessages: { gmail_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; account_email: string }[] = [];
  let from = 0;
  const batchSize = 1000;
  while (true) {
    const query = admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id, sender, sender_email, subject, snippet, date, account_email')
      .eq('user_id', userId)
      .eq('is_unread', true);
    if (account) query.eq('account_email', account);
    const { data: batch, error } = await query
      .order('date', { ascending: false })
      .range(from, from + batchSize - 1);

    if (error) return apiError(error.message, 500);
    if (!batch || batch.length === 0) break;
    allMessages.push(...batch);
    from += batchSize;
    if (batch.length < batchSize) break; // Last page
  }

  // Filter: exclude signal senders (A/B/C), actioned, and deduplicate
  const seenIds = new Set<string>();
  const noiseMessages = allMessages.filter(m => {
    if (actionedIds.has(m.gmail_id)) return false;
    if (seenIds.has(m.gmail_id)) return false;
    if (signalSenders.has(m.sender_email.toLowerCase())) return false;
    seenIds.add(m.gmail_id);
    return true;
  });

  // Group by domain or sender
  type MsgType = typeof noiseMessages[number];
  const groups: Record<string, { key: string; name: string; email: string; count: number; messages: MsgType[] }> = {};

  for (const m of noiseMessages) {
    let key: string;
    let name: string;
    let email: string;

    if (groupBy === 'domain') {
      const domain = (m.sender_email.split('@')[1] || '').toLowerCase();
      if (COMMON_DOMAINS.has(domain)) {
        key = m.sender_email.toLowerCase();
        name = m.sender || m.sender_email;
        email = m.sender_email;
      } else {
        key = `@${domain}`;
        name = domain;
        email = `@${domain}`;
      }
    } else {
      key = m.sender_email.toLowerCase();
      name = m.sender || m.sender_email;
      email = m.sender_email;
    }

    if (!groups[key]) {
      groups[key] = { key, name, email, count: 0, messages: [] };
    }
    groups[key].count++;
    groups[key].messages.push(m);
  }

  // Sort by count DESC
  const sorted = Object.values(groups).sort((a, b) => b.count - a.count);
  const total = sorted.length;
  const totalMessages = noiseMessages.length;

  // Paginate groups
  const page = sorted.slice(offset, offset + limit);

  return apiSuccess({
    groups: page.map(g => ({
      key: g.key,
      name: g.name,
      email: g.email,
      count: g.count,
      messages: g.messages.map((m: MsgType) => ({
        id: m.gmail_id,
        sender: m.sender,
        senderEmail: m.sender_email,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date,
        accountEmail: m.account_email,
      })),
    })),
    totalGroups: total,
    totalMessages,
    hasMore: offset + limit < total,
  });
}
