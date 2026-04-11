import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * GET /api/emailHelperV2/accounts
 * Returns all connected Gmail accounts for the current user
 */
export async function GET(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.GMAIL_ACCOUNTS)
    .select('email, is_primary, is_active_inbox, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

/**
 * PUT /api/emailHelperV2/accounts
 * Set primary account
 * Body: { email: string, action: 'set_primary' }
 */
export async function PUT(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { email, action } = body;

    if (action === 'set_primary') {
      const admin = createSupabaseAdmin();
      // Unset all as primary
      await admin
        .from(TABLES.GMAIL_ACCOUNTS)
        .update({ is_primary: false })
        .eq('user_id', userId);
      // Set the chosen one as primary
      await admin
        .from(TABLES.GMAIL_ACCOUNTS)
        .update({ is_primary: true })
        .eq('user_id', userId)
        .eq('email', email);
      // Update user profile
      await admin
        .from(TABLES.USER_PROFILES)
        .update({ primary_account: email })
        .eq('id', userId);

      return apiSuccess({ primary: email });
    }

    return apiError(`Unknown action: ${action}`);
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
