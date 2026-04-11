import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/rules
 * Returns notification rules for the current user
 */
export async function GET(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.NOTIFICATION_RULES)
    .select('*')
    .eq('user_id', userId)
    .order('default_priority', { ascending: false });

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

/**
 * PUT /api/emailHelperV2/rules
 * Update a notification rule's user_priority
 * Body: { id: string, user_priority: number }
 */
export async function PUT(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { id, user_priority } = body;

    if (!id) return apiError('Missing rule id');
    if (user_priority === undefined) return apiError('Missing user_priority');

    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from(TABLES.NOTIFICATION_RULES)
      .update({ user_priority })
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

/**
 * POST /api/emailHelperV2/rules
 * Add a new custom notification rule
 * Body: { pattern, category, description, default_priority, user_priority? }
 */
export async function POST(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();

    const admin = createSupabaseAdmin();
    const { data, error } = await admin
      .from(TABLES.NOTIFICATION_RULES)
      .upsert(
        {
          user_id: userId,
          pattern: body.pattern,
          category: body.category || 'Custom',
          description: body.description || body.pattern,
          default_priority: body.default_priority ?? 5,
          user_priority: body.user_priority ?? null,
        },
        { onConflict: 'user_id,pattern' }
      )
      .select()
      .single();

    if (error) return apiError(error.message, 500);
    return apiSuccess(data);
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
