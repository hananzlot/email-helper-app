import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { TABLES } from '@/lib/tables';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, getDriveClient, listMessages, getRawMessage, getLabelInfo } from '@/lib/gmail';
import { assembleMbox, MAX_MBOX_SIZE } from '@/lib/mbox';
import { ensureBackupFolder, uploadMboxFile, testDriveAccess } from '@/lib/google-drive';

/**
 * GET /api/emailHelperV2/backup
 * Check backup status for the current user.
 */
export async function GET(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data } = await admin
    .from(TABLES.BACKUP_JOBS)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  return apiSuccess(data || []);
}

/**
 * POST /api/emailHelperV2/backup
 * Start a backup job for an account.
 * Body: { account_email: string }
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json().catch(() => ({}));
  const { account_email } = body;
  if (!account_email) return apiError('Missing account_email');

  const admin = createSupabaseAdmin();

  // Check for existing active backup
  const { data: existing } = await admin
    .from(TABLES.BACKUP_JOBS)
    .select('*')
    .eq('user_id', userId)
    .eq('account_email', account_email)
    .in('status', ['pending', 'processing'])
    .limit(1)
    .single();

  if (existing) return apiSuccess(existing);

  // Check if Drive scope is authorized
  try {
    const token = await getValidGmailToken(userId, account_email);
    const drive = getDriveClient(token);
    const hasAccess = await testDriveAccess(drive);
    if (!hasAccess) {
      return apiSuccess({ needsDriveAuth: true });
    }
  } catch {
    return apiSuccess({ needsDriveAuth: true });
  }

  // Determine backup type: incremental if we have a previous backup
  const { data: lastBackup } = await admin
    .from(TABLES.BACKUP_JOBS)
    .select('last_message_date')
    .eq('user_id', userId)
    .eq('account_email', account_email)
    .eq('status', 'done')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single();

  const backupType = lastBackup?.last_message_date ? 'incremental' : 'full';

  // Get inbox + sent totals for progress tracking
  let totalMessages = 0;
  try {
    const token = await getValidGmailToken(userId, account_email);
    const gmail = getGmailClient(token);
    const inbox = await getLabelInfo(gmail, 'INBOX');
    const sent = await getLabelInfo(gmail, 'SENT');
    totalMessages = inbox.messagesTotal + sent.messagesTotal;
  } catch {}

  // Clean up old done/error jobs
  await admin
    .from(TABLES.BACKUP_JOBS)
    .delete()
    .eq('user_id', userId)
    .eq('account_email', account_email)
    .in('status', ['done', 'error']);

  const { data: job, error } = await admin
    .from(TABLES.BACKUP_JOBS)
    .insert({
      user_id: userId,
      account_email,
      status: 'pending',
      backup_type: backupType,
      folders: ['inbox', 'sent'],
      current_folder: 'inbox',
      messages_total: totalMessages,
      last_message_date: lastBackup?.last_message_date || null,
    })
    .select()
    .single();

  if (error) return apiError(error.message, 500);
  return apiSuccess(job);
}

/**
 * PUT /api/emailHelperV2/backup
 * Process one batch of the backup.
 * Each call fetches up to 50 raw messages, assembles MBOX, uploads when buffer is full.
 */
export async function PUT(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();

  // Get the next active backup job
  let { data: job } = await admin
    .from(TABLES.BACKUP_JOBS)
    .select('*')
    .eq('user_id', userId)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (!job) return apiSuccess({ idle: true });

  // Mark as processing
  if (job.status === 'pending') {
    const { data: started } = await admin
      .from(TABLES.BACKUP_JOBS)
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .select()
      .single();
    job = started || job;
  }

  let gmailCalls = 0;

  try {
    const token = await getValidGmailToken(job.user_id, job.account_email);
    const gmail = getGmailClient(token);
    const drive = getDriveClient(token);

    // Ensure backup folder exists in Drive
    let folderId = job.drive_folder_id;
    if (!folderId) {
      folderId = await ensureBackupFolder(drive);
      await admin.from(TABLES.BACKUP_JOBS).update({ drive_folder_id: folderId }).eq('id', job.id);
    }

    // Build query for current folder
    const folder = job.current_folder || 'inbox';
    let query = folder === 'sent' ? 'in:sent' : 'in:inbox';

    // For incremental: only messages after last backup
    if (job.backup_type === 'incremental' && job.last_message_date) {
      const afterDate = new Date(job.last_message_date);
      const epoch = Math.floor(afterDate.getTime() / 1000);
      query += ` after:${epoch}`;
    }

    // Get resume token from job metadata
    const resumeToken = job.resume_page_token || undefined;

    // Fetch one page of message IDs
    const listRes = await listMessages(gmail, { query, maxResults: 50, pageToken: resumeToken });
    gmailCalls++;

    if (!listRes.messages?.length) {
      // Current folder done — move to next folder or complete
      const folders = job.folders || ['inbox', 'sent'];
      const currentIdx = folders.indexOf(folder);

      if (currentIdx < folders.length - 1) {
        // Move to next folder
        await admin.from(TABLES.BACKUP_JOBS).update({
          current_folder: folders[currentIdx + 1],
          resume_page_token: null,
        }).eq('id', job.id);
        return apiSuccess({ status: 'processing', folder: folders[currentIdx + 1], gmailCalls });
      }

      // All folders done
      const newestDate = job.newest_message_date || new Date().toISOString();
      await admin.from(TABLES.BACKUP_JOBS).update({
        status: 'done',
        completed_at: new Date().toISOString(),
        last_message_date: newestDate,
      }).eq('id', job.id);

      return apiSuccess({ status: 'done', messagesProcessed: job.messages_processed, gmailCalls });
    }

    // Fetch raw messages in parallel (concurrency = 10)
    const messageIds = listRes.messages.map((m: { id?: string | null }) => m.id!).filter(Boolean);
    const rawMessages: { id: string; raw: string; internalDate: string }[] = [];

    for (let i = 0; i < messageIds.length; i += 10) {
      const batch = messageIds.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (id) => {
          try {
            gmailCalls++;
            return await getRawMessage(gmail, id);
          } catch {
            return null;
          }
        })
      );
      rawMessages.push(...results.filter((m): m is NonNullable<typeof m> => m !== null));
    }

    // Track newest message date for incremental
    let newestDate = job.newest_message_date || null;
    for (const msg of rawMessages) {
      const msgDate = new Date(parseInt(msg.internalDate)).toISOString();
      if (!newestDate || msgDate > newestDate) newestDate = msgDate;
    }

    // Assemble MBOX
    const mboxBuffer = assembleMbox(rawMessages);
    const totalProcessed = (job.messages_processed || 0) + rawMessages.length;
    const partNum = (job.drive_file_ids?.length || 0) + 1;

    // Upload if buffer is meaningful (>0 messages) and either:
    // - No more pages (last batch)
    // - Buffer would exceed max size threshold
    const shouldUpload = rawMessages.length > 0;
    let newFileIds = [...(job.drive_file_ids || [])];

    if (shouldUpload) {
      const dateStr = new Date().toISOString().split('T')[0];
      const fileName = `${job.account_email}_${folder}_${dateStr}_part${partNum}.mbox`;
      const fileId = await uploadMboxFile(drive, folderId, fileName, mboxBuffer);
      newFileIds.push(fileId);
    }

    // Save resume token and progress
    await admin.from(TABLES.BACKUP_JOBS).update({
      messages_processed: totalProcessed,
      resume_page_token: listRes.nextPageToken || null,
      drive_file_ids: newFileIds,
      newest_message_date: newestDate,
    }).eq('id', job.id);

    return apiSuccess({
      status: 'processing',
      folder,
      messagesProcessed: totalProcessed,
      messagesTotal: job.messages_total,
      batchSize: rawMessages.length,
      uploaded: shouldUpload,
      gmailCalls,
    });
  } catch (err) {
    const errMsg = String(err);
    const isQuotaError = errMsg.toLowerCase().includes('quota');

    if (isQuotaError) {
      return apiSuccess({ status: 'quota_retry', error: errMsg, gmailCalls });
    }

    await admin.from(TABLES.BACKUP_JOBS).update({
      status: 'error',
      error_message: errMsg,
      completed_at: new Date().toISOString(),
    }).eq('id', job.id);

    return apiSuccess({ status: 'error', error: errMsg, gmailCalls });
  }
}
