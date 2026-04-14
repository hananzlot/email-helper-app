import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';

/**
 * POST /api/emailHelperV2/feedback
 * Submit feedback, feature request, or bug report.
 * Body: { type: 'bug' | 'feature' | 'feedback', message: string }
 */
export async function POST(request: NextRequest) {
  const { userId, account } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json();
  const { type, message } = body;

  if (!type || !message?.trim()) return apiError('Type and message are required');
  if (!['bug', 'feature', 'feedback'].includes(type)) return apiError('Invalid type');
  if (message.length > 5000) return apiError('Message too long (max 5000 chars)');

  const admin = createSupabaseAdmin();
  const { error } = await admin.from(TABLES.FEEDBACK).insert({
    user_id: userId,
    user_email: account || '',
    type,
    message: message.trim(),
    status: 'new',
  });

  if (error) {
    console.error('Feedback insert failed:', error.message);
    return apiError('Failed to submit feedback', 500);
  }

  return apiSuccess({ submitted: true });
}

/**
 * GET /api/emailHelperV2/feedback
 * Returns all feedback (admin) or user's own feedback.
 * Query: ?admin=true for all feedback (requires admin auth)
 */
export async function GET(request: NextRequest) {
  const isAdmin = request.nextUrl.searchParams.get('admin') === 'true';
  const supaAdmin = createSupabaseAdmin();

  if (isAdmin) {
    // Verify admin session
    const adminAuth = request.cookies.get('clearbox_admin_session')?.value;
    // For admin, also accept sessionStorage-based auth verified by checking the header
    const adminHeader = request.headers.get('x-admin-auth');
    if (!adminAuth && adminHeader !== 'true') {
      return apiError('Admin access required', 403);
    }

    const { data, error } = await supaAdmin
      .from(TABLES.FEEDBACK)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) return apiError(error.message, 500);
    return apiSuccess(data || []);
  }

  // Regular user — return their own feedback
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const { data, error } = await supaAdmin
    .from(TABLES.FEEDBACK)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

/**
 * PUT /api/emailHelperV2/feedback
 * Update feedback status/notes (admin only).
 * Body: { id, status?, admin_notes? }
 */
export async function PUT(request: NextRequest) {
  const adminHeader = request.headers.get('x-admin-auth');
  if (adminHeader !== 'true') return apiError('Admin access required', 403);

  const body = await request.json();
  const { id, status, admin_notes } = body;
  if (!id) return apiError('Missing feedback id');

  const updates: Record<string, unknown> = {};
  if (status) updates.status = status;
  if (admin_notes !== undefined) updates.admin_notes = admin_notes;
  if (status === 'reviewed' || status === 'resolved') updates.reviewed_at = new Date().toISOString();

  const admin = createSupabaseAdmin();
  const { error } = await admin.from(TABLES.FEEDBACK).update(updates).eq('id', id);

  if (error) return apiError(error.message, 500);
  return apiSuccess({ updated: true });
}
