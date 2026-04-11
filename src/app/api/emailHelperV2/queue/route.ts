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

  // Fetch queue and sender priorities in parallel
  const [queueResult, sendersResult] = await Promise.all([
    admin
      .from(TABLES.REPLY_QUEUE)
      .select('*')
      .eq('user_id', userId)
      .order('priority_score', { ascending: false }),
    admin
      .from(TABLES.SENDER_PRIORITIES)
      .select('sender_email, reply_count')
      .eq('user_id', userId),
  ]);

  if (queueResult.error) return apiError(queueResult.error.message, 500);

  // Build lookup of reply counts by sender email
  const replyCountMap: Record<string, number> = {};
  if (sendersResult.data) {
    for (const s of sendersResult.data) {
      replyCountMap[s.sender_email] = s.reply_count || 0;
    }
  }

  // Enrich queue items with reply_count and sort: within same priority, higher reply_count first
  const enriched = (queueResult.data || []).map((item: Record<string, unknown>) => ({
    ...item,
    reply_count: replyCountMap[item.sender_email as string] || 0,
  }));

  // Sort by priority_score desc, then reply_count desc as tiebreaker
  enriched.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    if ((b.priority_score as number) !== (a.priority_score as number)) return (b.priority_score as number) - (a.priority_score as number);
    return (b.reply_count as number) - (a.reply_count as number);
  });

  return apiSuccess(enriched);
}

/**
 * POST /api/emailHelperV2/queue
 * Create a new queue item (e.g. when snoozing from a tab that doesn't have a queue entry)
 * Body: { message_id, account_email, status, snoozed_until?, sender?, sender_email?, subject?, summary?, ... }
 */
export async function POST(request: NextRequest) {
  const { userId } = getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { message_id, account_email, status, snoozed_until, sender, sender_email, subject, summary, thread_id, tier, priority, priority_score, gmail_url } = body;

    if (!message_id || !status) return apiError('Missing message_id or status');

    const admin = createSupabaseAdmin();
    const item: Record<string, unknown> = {
      user_id: userId,
      message_id,
      account_email: account_email || '',
      status,
      sender: sender || '',
      sender_email: sender_email || '',
      subject: subject || '',
      summary: summary || '',
      thread_id: thread_id || null,
      tier: tier || null,
      priority: priority || 'normal',
      priority_score: priority_score || 5,
      gmail_url: gmail_url || null,
      received: new Date().toISOString(),
    };
    if (snoozed_until) item.snoozed_until = snoozed_until;

    const { data, error } = await admin
      .from(TABLES.REPLY_QUEUE)
      .upsert(item, { onConflict: 'user_id,message_id' })
      .select()
      .single();

    if (error) return apiError(error.message, 500);
    return apiSuccess(data);
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
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
    const { id, message_id, status, snoozed_until } = body;

    if ((!id && !message_id) || !status) return apiError('Missing id/message_id or status');

    const admin = createSupabaseAdmin();
    const update: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (snoozed_until) update.snoozed_until = snoozed_until;

    // Support lookup by either queue ID or Gmail message_id
    let query = admin.from(TABLES.REPLY_QUEUE).update(update).eq('user_id', userId);
    if (id) {
      query = query.eq('id', id);
    } else {
      query = query.eq('message_id', message_id);
    }

    const { data, error } = await query.select();

    if (error) return apiError(error.message, 500);
    return apiSuccess(data?.[0] || { updated: true });
  } catch (err) {
    return apiError(`Failed: ${err}`, 500);
  }
}
