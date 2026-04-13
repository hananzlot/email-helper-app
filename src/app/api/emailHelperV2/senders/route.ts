import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { encryptFields, decryptFields, ENCRYPTED_FIELDS } from '@/lib/crypto';

/**
 * GET /api/emailHelperV2/senders
 * Returns all sender priorities for the current user, sorted by reply count
 */
export async function GET(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(TABLES.SENDER_PRIORITIES)
    .select('*')
    .eq('user_id', userId)
    .order('reply_count', { ascending: false });

  if (error) return apiError(error.message, 500);
  // Decrypt display_name for each sender
  const decrypted = (data || []).map((s: Record<string, unknown>) =>
    decryptFields(s, [...ENCRYPTED_FIELDS.SENDER_PRIORITIES], userId)
  );
  return apiSuccess(decrypted);
}

/**
 * POST /api/emailHelperV2/senders
 * Bulk upsert sender priorities (for seeding from existing data)
 * Body: { senders: [{ sender_email, display_name, reply_count, last_reply, tier }] }
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const senders = body.senders || [];

    const upserts = senders.map((s: Record<string, unknown>) => {
      const item = {
        user_id: userId,
        sender_email: s.sender_email as string,
        display_name: (s.display_name || '') as string,
        reply_count: (s.reply_count || 0) as number,
        last_reply: (s.last_reply || null) as string | null,
        tier: (s.tier || 'D') as string,
        accounts_seen: (s.accounts_seen || []) as string[],
      };
      return encryptFields(item, [...ENCRYPTED_FIELDS.SENDER_PRIORITIES], userId);
    });

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
    console.error('Senders operation failed:', err);
    return apiError('Operation failed', 500);
  }
}

/**
 * PUT /api/emailHelperV2/senders
 * Update a sender's tier, or merge two senders
 * Body: { sender_email: string, tier: 'A' | 'B' | 'C' | 'D' }
 * OR:   { action: 'merge', primary_email: string, secondary_email: string }
 */
export async function PUT(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const admin = createSupabaseAdmin();

    // Merge action: combine two senders into one
    if (body.action === 'merge') {
      const { primary_email, secondary_email } = body;
      if (!primary_email || !secondary_email) return apiError('Missing primary_email or secondary_email');

      // Fetch both senders
      const [primaryRes, secondaryRes] = await Promise.all([
        admin.from(TABLES.SENDER_PRIORITIES).select('*').eq('user_id', userId).eq('sender_email', primary_email).single(),
        admin.from(TABLES.SENDER_PRIORITIES).select('*').eq('user_id', userId).eq('sender_email', secondary_email).single(),
      ]);

      if (!primaryRes.data && !secondaryRes.data) return apiError('Neither sender found');

      const primary = primaryRes.data || secondaryRes.data;
      const secondary = secondaryRes.data || primaryRes.data;

      // Merge: add reply counts, keep higher tier, combine accounts_seen
      const tierRank: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };
      const bestTier = (tierRank[primary.tier] || 0) >= (tierRank[secondary.tier] || 0) ? primary.tier : secondary.tier;
      const combinedCount = (primary.reply_count || 0) + (secondary.reply_count || 0);
      const combinedAccounts = [...new Set([...(primary.accounts_seen || []), ...(secondary.accounts_seen || [])])];
      const aliases = [...new Set([...(primary.aliases || []), secondary.sender_email])];

      // Update primary with merged data
      await admin.from(TABLES.SENDER_PRIORITIES)
        .update({
          reply_count: combinedCount,
          tier: bestTier,
          accounts_seen: combinedAccounts,
          aliases: aliases,
          display_name: primary.display_name || secondary.display_name,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('sender_email', primary.sender_email);

      // Delete the secondary
      await admin.from(TABLES.SENDER_PRIORITIES)
        .delete()
        .eq('user_id', userId)
        .eq('sender_email', secondary.sender_email);

      return apiSuccess({ merged: true, primary: primary.sender_email, removed: secondary.sender_email, combined_count: combinedCount });
    }

    // Auto-archive toggle update
    if ('auto_archive_updates' in body && body.sender_email && !body.tier) {
      const { sender_email, auto_archive_updates } = body;
      const { data, error } = await admin
        .from(TABLES.SENDER_PRIORITIES)
        .update({ auto_archive_updates: !!auto_archive_updates, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('sender_email', sender_email)
        .select()
        .single();
      if (error) return apiError(error.message, 500);
      return apiSuccess(data);
    }

    // Regular tier update
    const { sender_email, tier, display_name } = body;
    if (!sender_email || !tier) return apiError('Missing sender_email or tier');
    if (!['A', 'B', 'C', 'D'].includes(tier)) return apiError('Tier must be A, B, C, or D');

    // Upsert so it works for both known and unknown senders (encrypt display_name)
    const upsertItem = encryptFields({
      user_id: userId,
      sender_email,
      tier,
      display_name: display_name || sender_email,
      reply_count: 0,
      updated_at: new Date().toISOString(),
    }, [...ENCRYPTED_FIELDS.SENDER_PRIORITIES], userId);

    const { data, error } = await admin
      .from(TABLES.SENDER_PRIORITIES)
      .upsert(upsertItem, { onConflict: 'user_id,sender_email' })
      .select()
      .single();

    if (error) return apiError(error.message, 500);
    return apiSuccess(data);
  } catch (err) {
    console.error('Senders operation failed:', err);
    return apiError('Operation failed', 500);
  }
}

/**
 * DELETE /api/emailHelperV2/senders
 * Remove a sender from priorities
 * Body: { sender_email: string }
 */
export async function DELETE(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  try {
    const body = await request.json();
    const { sender_email } = body;
    if (!sender_email) return apiError('Missing sender_email');

    const admin = createSupabaseAdmin();
    const { error } = await admin
      .from(TABLES.SENDER_PRIORITIES)
      .delete()
      .eq('user_id', userId)
      .eq('sender_email', sender_email);

    if (error) return apiError(error.message, 500);
    return apiSuccess({ deleted: sender_email });
  } catch (err) {
    console.error('Senders operation failed:', err);
    return apiError('Operation failed', 500);
  }
}
