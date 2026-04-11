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

    const items = typeof data.data === 'string'
      ? decryptJson(data.data, userId)
      : data.data;

    return apiSuccess({
      items: items || [],
      computed_at: data.computed_at,
      starred_count: data.starred_count,
      awaiting_count: data.awaiting_count,
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

  return apiSuccess({
    items: allItems,
    computed_at: latestComputed,
    starred_count: data.reduce((s: number, r: { starred_count?: number }) => s + (r.starred_count || 0), 0),
    awaiting_count: data.reduce((s: number, r: { awaiting_count?: number }) => s + (r.awaiting_count || 0), 0),
  });
}
