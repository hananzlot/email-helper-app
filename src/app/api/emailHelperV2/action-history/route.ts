import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { encrypt, decrypt } from '@/lib/crypto';

const TABLE = TABLES.ACTION_HISTORY;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/emailHelperV2/action-history
 * Returns the last 7 days of actions for the current user, newest first.
 */
export async function GET(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  const { data, error } = await admin
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) return apiError(error.message, 500);

  // Decrypt sensitive fields
  const decrypted = (data || []).map((row: Record<string, unknown>) => ({
    id: row.id,
    action: row.action,
    label: decrypt(row.action_label as string, userId),
    messageIds: row.message_ids,
    accountEmail: decrypt(row.account_email as string, userId),
    subjects: (() => { try { return JSON.parse(decrypt(row.subjects as string, userId)); } catch { return []; } })(),
    timestamp: new Date(row.created_at as string).getTime(),
    undoAction: row.undo_action,
    undone: row.undone,
  }));

  return apiSuccess(decrypted);
}

/**
 * POST /api/emailHelperV2/action-history
 * Log a new action.
 */
export async function POST(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json();
  const { action, label, messageIds, accountEmail, subjects, undoAction } = body;

  if (!action || !label) return apiError('Missing action or label', 400);

  const admin = createSupabaseAdmin();

  const { data, error } = await admin.from(TABLE).insert({
    user_id: userId,
    action,
    action_label: encrypt(label, userId),
    message_ids: messageIds || [],
    account_email: encrypt(accountEmail || '', userId),
    subjects: encrypt(JSON.stringify(subjects || []), userId),
    undo_action: undoAction || null,
    undone: false,
  }).select('id, created_at').single();

  if (error) return apiError(error.message, 500);

  return apiSuccess({ id: data.id, timestamp: new Date(data.created_at).getTime() });
}

/**
 * PUT /api/emailHelperV2/action-history
 * Update an action (e.g., mark as undone).
 */
export async function PUT(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json();
  const { id, undone } = body;

  if (!id) return apiError('Missing id', 400);

  const admin = createSupabaseAdmin();

  const { error } = await admin
    .from(TABLE)
    .update({ undone: undone ?? true })
    .eq('id', id)
    .eq('user_id', userId);

  if (error) return apiError(error.message, 500);

  return apiSuccess({ ok: true });
}

/**
 * DELETE /api/emailHelperV2/action-history
 * Clear all action history for the current user.
 */
export async function DELETE(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();

  const { error } = await admin
    .from(TABLE)
    .delete()
    .eq('user_id', userId);

  if (error) return apiError(error.message, 500);

  return apiSuccess({ ok: true });
}
