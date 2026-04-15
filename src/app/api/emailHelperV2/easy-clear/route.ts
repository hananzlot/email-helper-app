import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

const COMMON_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'protonmail.com', 'mail.com',
]);

/**
 * GET /api/emailHelperV2/easy-clear
 *
 * Two modes:
 *   Default — returns grouped sender counts (fast SQL, no message bodies)
 *   ?mode=messages&sender=email — returns messages for a specific sender/domain
 *
 * Groups mode handles 76K+ messages by only fetching sender_email for counting.
 * Messages mode is called per-group when user expands or client pre-fetches.
 */
export async function GET(request: NextRequest) {
  const { userId, account } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const mode = request.nextUrl.searchParams.get('mode') || 'groups';
  const limit = parseInt(request.nextUrl.searchParams.get('limit') || '50');
  const offset = parseInt(request.nextUrl.searchParams.get('offset') || '0');
  const groupBy = request.nextUrl.searchParams.get('groupBy') || 'domain';

  const admin = createSupabaseAdmin();

  // Get signal senders (A/B/C) + their domains to exclude
  const { data: senders } = await admin
    .from(TABLES.SENDER_PRIORITIES)
    .select('sender_email, tier, aliases')
    .eq('user_id', userId)
    .in('tier', ['A', 'B', 'C']);

  const signalSenders = new Set<string>();
  const signalDomains = new Set<string>();
  if (senders) {
    for (const s of senders) {
      signalSenders.add(s.sender_email.toLowerCase());
      for (const alias of (s.aliases || [])) signalSenders.add(alias.toLowerCase());
      const domain = s.sender_email.split('@')[1]?.toLowerCase();
      if (domain && !COMMON_DOMAINS.has(domain)) signalDomains.add(domain);
    }
  }

  // ============ MESSAGES MODE: fetch messages for a specific sender/domain ============
  if (mode === 'messages') {
    const senderFilter = request.nextUrl.searchParams.get('sender') || '';
    if (!senderFilter) return apiError('Missing sender param');

    const isDomain = senderFilter.startsWith('@');
    const query = admin
      .from(TABLES.INBOX_CACHE)
      .select('gmail_id, sender, sender_email, subject, snippet, date, account_email')
      .eq('user_id', userId)
      .eq('is_unread', true);
    if (account) query.eq('account_email', account);
    if (isDomain) {
      query.ilike('sender_email', `%${senderFilter.slice(1)}`);
    } else {
      query.eq('sender_email', senderFilter);
    }
    const { data, error } = await query.order('date', { ascending: false }).limit(500);
    if (error) return apiError(error.message, 500);

    return apiSuccess({
      messages: (data || []).map((m: { gmail_id: string; sender: string; sender_email: string; subject: string; snippet: string; date: string; account_email: string }) => ({
        id: m.gmail_id, sender: m.sender, senderEmail: m.sender_email,
        subject: m.subject, snippet: m.snippet, date: m.date, accountEmail: m.account_email,
      })),
    });
  }

  // ============ GROUPS MODE: count by sender, fast ============
  // Fetch only sender_email column in batches (minimal payload for 76K+ rows)
  const senderCounts: Record<string, { sender: string; senderEmail: string; count: number; accountEmail: string }> = {};
  let from = 0;
  const batchSize = 1000;
  let totalScanned = 0;

  while (true) {
    const query = admin
      .from(TABLES.INBOX_CACHE)
      .select('sender, sender_email, account_email')
      .eq('user_id', userId)
      .eq('is_unread', true);
    if (account) query.eq('account_email', account);
    const { data: batch, error } = await query
      .order('date', { ascending: false })
      .range(from, from + batchSize - 1);

    if (error) return apiError(error.message, 500);
    if (!batch || batch.length === 0) break;

    for (const m of batch) {
      const email = (m.sender_email || '').toLowerCase();
      if (signalSenders.has(email)) continue;
      const domain = email.split('@')[1] || '';
      if (domain && signalDomains.has(domain)) continue;

      const key = groupBy === 'domain' && !COMMON_DOMAINS.has(domain)
        ? `@${domain}` : email;

      if (!senderCounts[key]) {
        senderCounts[key] = {
          sender: groupBy === 'domain' && !COMMON_DOMAINS.has(domain) ? domain : (m.sender || email),
          senderEmail: key,
          count: 0,
          accountEmail: m.account_email,
        };
      }
      senderCounts[key].count++;
    }

    totalScanned += batch.length;
    from += batchSize;
    if (batch.length < batchSize) break;
  }

  // Sort by count DESC
  const sorted = Object.values(senderCounts).sort((a, b) => b.count - a.count);
  const totalGroups = sorted.length;
  const totalMessages = sorted.reduce((s, g) => s + g.count, 0);

  // Paginate
  const page = sorted.slice(offset, offset + limit);

  return apiSuccess({
    groups: page.map(g => ({
      key: g.senderEmail,
      name: g.sender,
      email: g.senderEmail,
      count: g.count,
      messages: [], // Fetched separately via mode=messages
    })),
    totalGroups,
    totalMessages,
    totalScanned,
    hasMore: offset + limit < totalGroups,
  });
}
