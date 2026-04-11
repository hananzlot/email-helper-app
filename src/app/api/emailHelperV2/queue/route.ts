import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/queue
 * Returns the reply queue for the current user
 */
export async function GET(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.REPLY_QUEUE)
    .select('*')
    .eq('user_id', userId)
    .order('priority_score', { ascending: false });

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

/**
 * PUT /api/emailHelperV2/queue
 * Update a queue item's status (done, snoozed, later, active)
 * Body: { id: string, status: string, snoozed_until?: string }
 */
export async function PUT(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { id, status, snoozed_until } = body;

    if (!id || !status) return apiError('Missing id or status');

    const admin = createSupabaseAdmin();
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (snoozed_until) update.snoozed_until = snoozed_until;

    const { data, error } = await admin
      .from(TABLES.REPLY_QUEUE)
      .update(update)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) return apiError(error.message, 500);
    return apiSuccess(data);
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
