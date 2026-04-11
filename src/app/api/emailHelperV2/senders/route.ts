import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/senders
 * Returns all sender priorities for the current user, sorted by reply count
 */
export async function GET(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.SENDER_PRIORITIES)
    .select('*')
    .eq('user_id', userId)
    .order('reply_count', { ascending: false });

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

/**
 * POST /api/emailHelperV2/senders
 * Bulk upsert sender priorities (for seeding from existing data)
 * Body: { senders: [{ sender_email, display_name, reply_count, last_reply, tier }] }
 */
export async function POST(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const senders = body.senders || [];

    const upserts = senders.map((s: Record<string, unknown>) => ({
      user_id: userId,
      sender_email: s.sender_email,
      display_name: s.display_name,
      reply_count: s.reply_count || 0,
      last_reply: s.last_reply || null,
      tier: s.tier || 'D',
      accounts_seen: s.accounts_seen || [],
    }));

    const admin = createSupabaseAdmin();
    // Batch in chunks of 100
    for (let i = 0; i < upserts.length; i += 100) {
      const chunk = upserts.slice(i, i + 100);
      const { error } = await admin
        .from(TABLES.SENDER_PRIORITIES)
        .upsert(chunk, { onConflict: 'user_id,sender_email' });
      if (error) return apiError(error.message, 500);
    }

    return apiSuccess({ imported: upserts.length });
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
