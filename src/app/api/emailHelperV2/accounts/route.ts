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

/**
 * DELETE /api/emailHelperV2/accounts
 * Disconnect (remove) a connected Gmail account and all its associated data
 * Body: { email: string }
 */
export async function DELETE(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { email } = body;
    if (!email) return apiError('Missing email');

    const admin = createSupabaseAdmin();

    // Check this isn't the only account
    const { data: allAccounts } = await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .select('email, is_primary')
      .eq('user_id', userId);

    if (!allAccounts || allAccounts.length <= 1) {
      return apiError('Cannot disconnect your only account. Add another account first.', 400);
    }

    // Delete the account record
    await admin
      .from(TABLES.GMAIL_ACCOUNTS)
      .delete()
      .eq('user_id', userId)
      .eq('email', email);

    // Clean up associated data
    await Promise.all([
      // Remove queue items for this account
      admin
        .from(TABLES.REPLY_QUEUE)
        .delete()
        .eq('user_id', userId)
        .eq('account_email', email),
      // Remove triage results for this account
      admin
        .from(TABLES.TRIAGE_RESULTS)
        .delete()
        .eq('user_id', userId)
        .eq('account_email', email),
    ]);

    // If disconnected account was primary, set another as primary
    const wasPrimary = allAccounts.find((a: { email: string; is_primary: boolean }) => a.email === email)?.is_primary;
    if (wasPrimary) {
      const remaining = allAccounts.filter((a: { email: string }) => a.email !== email);
      if (remaining.length > 0) {
        await admin
          .from(TABLES.GMAIL_ACCOUNTS)
          .update({ is_primary: true })
          .eq('user_id', userId)
          .eq('email', remaining[0].email);
        await admin
          .from(TABLES.USER_PROFILES)
          .update({ primary_account: remaining[0].email })
          .eq('id', userId);
      }
    }

    return apiSuccess({ disconnected: email });
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
