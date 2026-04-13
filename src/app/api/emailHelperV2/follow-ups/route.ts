import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { decryptJson } from '@/lib/crypto';

/**
 * GET /api/emailHelperV2/follow-ups?account=email
 * Returns cached follow-up items for the current user/account.
 * The cache is pre-computed by the cron job via computeFollowUps().
 */
export async function GET(request: NextRequest) {
  const { userId, account } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();

  // Get actioned message IDs to exclude (same pattern as inbox-cache)
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

  // If account specified, get just that account's cache
  // If no account (unified), get all accounts' caches
  if (account) {
    const { data, error } = await admin
      .from(TABLES.FOLLOW_UP_CACHE)
      .select('*')
      .eq('user_id', userId)
      .eq('account_email', account)
      .single();

    if (error || !data) {
      return apiSuccess({ items: [], computed_at: null, message: 'No follow-up data cached yet. It will be computed on the next triage run.' });
    }

    const rawItems = (typeof data.data === 'string'
      ? decryptJson(data.data, userId)
      : data.data) as { message_id?: string; type?: string }[] || [];

    const items = rawItems.filter(i => !i.message_id || !actionedIds.has(i.message_id));
    const starred = items.filter(i => i.type === 'starred').length;
    const awaiting = items.filter(i => i.type === 'awaiting').length;

    return apiSuccess({
      items,
      computed_at: data.computed_at,
      starred_count: starred,
      awaiting_count: awaiting,
    });
  }

  // Unified: get all accounts
  const { data, error } = await admin
    .from(TABLES.FOLLOW_UP_CACHE)
    .select('*')
    .eq('user_id', userId);

  if (error || !data || data.length === 0) {
    return apiSuccess({ items: [], computed_at: null, message: 'No follow-up data cached yet.' });
  }

  // Merge all accounts' items
  const allItems: unknown[] = [];
  let latestComputed: string | null = null;

  for (const row of data) {
    const items = typeof row.data === 'string'
      ? decryptJson<unknown[]>(row.data, userId) || []
      : (row.data as unknown[]) || [];
    allItems.push(...items);
    if (!latestComputed || row.computed_at > latestComputed) {
      latestComputed = row.computed_at;
    }
  }

  const filteredItems = allItems.filter((i: unknown) => {
    const item = i as { message_id?: string };
    return !item.message_id || !actionedIds.has(item.message_id);
  });
  const starred = filteredItems.filter((i: unknown) => (i as { type?: string }).type === 'starred').length;
  const awaiting = filteredItems.filter((i: unknown) => (i as { type?: string }).type === 'awaiting').length;

  return apiSuccess({
    items: filteredItems,
    computed_at: latestComputed,
    starred_count: starred,
    awaiting_count: awaiting,
  });
}
