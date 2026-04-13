import { google, gmail_v1 } from 'googleapis';
import type { GmailMessage, GmailAttachment, GmailDraft, GmailLabel, GmailAction } from '@/types';

// ============ AUTH ============

export function getOAuth2Client(redirectUri?: string) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri || `${process.env.NEXT_PUBLIC_APP_URL}/api/emailHelperV2/auth/callback`
  );
}

export function getGmailClient(accessToken: string, refreshToken?: string) {
  const auth = getOAuth2Client();
  auth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return google.gmail({ version: 'v1', auth });
}

// Gmail scopes — full access scope covers read, modify, compose, send, delete
export const GMAIL_SCOPES = [
  'https://mail.google.com/',  // Full access — needed for permanent delete
  'openid',
  'email',
  'profile',
];

// ============ READ OPERATIONS ============

export async function getProfile(gmail: gmail_v1.Gmail) {
  const res = await gmail.users.getProfile({ userId: 'me' });
  return res.data;
}

export async function listMessages(
  gmail: gmail_v1.Gmail,
  options: {
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string;
  } = {}
) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: options.query,
    maxResults: options.maxResults || 20,
    labelIds: options.labelIds,
    pageToken: options.pageToken,
  });
  return {
    messages: res.data.messages || [],
    nextPageToken: res.data.nextPageToken,
    resultSizeEstimate: res.data.resultSizeEstimate,
  };
}

export async function getMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  format: 'full' | 'metadata' | 'minimal' = 'metadata'
): Promise<GmailMessage> {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format,
  });
  const msg = res.data;
  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  // Extract body for full format
  let body = '';
  let bodyHtml = '';
  let attachments: GmailAttachment[] = [];
  if (format === 'full' && msg.payload) {
    body = extractBody(msg.payload, 'text/plain') || extractBody(msg.payload, 'text/html');
    bodyHtml = extractBody(msg.payload, 'text/html') || body;
    attachments = extractAttachments(msg.payload, msg.id!);

    // Resolve inline CID images — replace cid: references with data: URLs
    const inlineImages = extractInlineImages(msg.payload);
    for (const [cid, dataUrl] of Object.entries(inlineImages)) {
      // CID can appear as "cid:abc" or "cid:abc@domain"
      const cidPattern = new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
      bodyHtml = bodyHtml.replace(cidPattern, dataUrl);
    }
  }

  const fromHeader = getHeader('From');
  const senderMatch = fromHeader.match(/^(.+?)\s*<(.+?)>$/);

  return {
    id: msg.id!,
    threadId: msg.threadId!,
    sender: senderMatch ? senderMatch[1].replace(/"/g, '').trim() : fromHeader,
    senderEmail: senderMatch ? senderMatch[2] : fromHeader,
    subject: getHeader('Subject'),
    snippet: msg.snippet || '',
    body,
    bodyHtml,
    to: getHeader('To'),
    cc: getHeader('Cc'),
    date: getHeader('Date'),
    labelIds: msg.labelIds || [],
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    attachments,
  };
}

function extractBody(payload: gmail_v1.Schema$MessagePart, preferMime?: string): string {
  const target = preferMime || 'text/html';
  const fallback = target === 'text/html' ? 'text/plain' : 'text/html';

  // Direct match
  if (payload.mimeType === target && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (!preferMime && payload.mimeType === fallback && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    // First pass: exact match
    for (const part of payload.parts) {
      if (part.mimeType === target && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Second pass: fallback
    if (!preferMime) {
      for (const part of payload.parts) {
        if (part.mimeType === fallback && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }
    // Recurse into multipart
    for (const part of payload.parts) {
      const result = extractBody(part, preferMime);
      if (result) return result;
    }
  }
  return '';
}

function extractAttachments(payload: gmail_v1.Schema$MessagePart, messageId: string): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];

  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return attachments;
}

/**
 * Extract inline images (Content-Disposition: inline with Content-ID)
 * and return a map of CID → data:URL so we can replace cid: references in the HTML body.
 */
function extractInlineImages(payload: gmail_v1.Schema$MessagePart): Record<string, string> {
  const images: Record<string, string> = {};

  function walk(part: gmail_v1.Schema$MessagePart) {
    const contentId = part.headers?.find(h => h.name?.toLowerCase() === 'content-id')?.value;
    const mimeType = part.mimeType || '';

    if (contentId && mimeType.startsWith('image/') && part.body?.data) {
      // Content-ID is usually <abc@domain> — strip angle brackets
      const cid = contentId.replace(/^<|>$/g, '');
      // Gmail returns base64url — convert to standard base64 for data URL
      const base64 = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
      images[cid] = `data:${mimeType};base64,${base64}`;
    }

    if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return images;
}

/**
 * Fetch attachment data from Gmail.
 * Returns base64url-encoded data string.
 */
export async function getAttachment(
  client: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  const res = await client.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  return {
    data: res.data.data || '',
    size: res.data.size || 0,
  };
}

export async function getThread(gmail: gmail_v1.Gmail, threadId: string) {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
  });
  return res.data;
}

export async function searchMessages(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults = 20
) {
  return listMessages(gmail, { query, maxResults });
}

// ============ LABELS ============

export async function listLabels(gmail: gmail_v1.Gmail): Promise<GmailLabel[]> {
  const res = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels || [];
  return labels.map((l) => ({
    id: l.id!,
    name: l.name!,
    type: l.type || 'user',
    messagesTotal: l.messagesTotal || 0,
    messagesUnread: l.messagesUnread || 0,
  }));
}

/**
 * Batch get message metadata — 10x faster than individual getMessage calls.
 * Fetches up to 50 messages in parallel using Promise.all.
 */
export async function batchGetMessageMetadata(
  gmail: gmail_v1.Gmail,
  messageIds: string[],
  concurrency = 50
): Promise<GmailMessage[]> {
  const results: GmailMessage[] = [];
  for (let i = 0; i < messageIds.length; i += concurrency) {
    const batch = messageIds.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        try {
          return await getMessage(gmail, id, 'metadata');
        } catch {
          return null;
        }
      })
    );
    results.push(...batchResults.filter((m): m is GmailMessage => m !== null));
  }
  return results;
}

/**
 * Cache inbox messages server-side — paginates through inbox and stores in Supabase.
 * Designed for cron jobs / background tasks (no browser dependency).
 */
export async function cacheInboxMessages(
  gmail: gmail_v1.Gmail,
  userId: string,
  accountEmail: string,
  maxMessages = 100000
): Promise<{ cached: number; total: number }> {
  const { createSupabaseAdmin } = await import('./supabase-server');
  const { TABLES } = await import('./tables');
  const admin = createSupabaseAdmin();

  // Check how many are already cached
  const { count: existingCount } = await admin
    .from(TABLES.INBOX_CACHE)
    .select('gmail_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('account_email', accountEmail);

  const alreadyCached = existingCount || 0;

  // Get exact inbox count
  const labelInfo = await getLabelInfo(gmail, 'INBOX');
  const totalInbox = labelInfo.messagesTotal;

  if (alreadyCached >= totalInbox || alreadyCached >= maxMessages) {
    // Update sync timestamp
    await admin.from(TABLES.INBOX_SYNC).upsert({
      user_id: userId, account_email: accountEmail,
      last_synced_at: new Date().toISOString(), total_cached: alreadyCached,
    }, { onConflict: 'user_id,account_email' });
    return { cached: alreadyCached, total: totalInbox };
  }

  // Get existing cached IDs to skip
  const { data: existingIds } = await admin
    .from(TABLES.INBOX_CACHE)
    .select('gmail_id')
    .eq('user_id', userId)
    .eq('account_email', accountEmail);
  const cachedIdSet = new Set((existingIds || []).map((r: { gmail_id: string }) => r.gmail_id));

  // Paginate through inbox
  let pageToken: string | undefined;
  let totalCached = alreadyCached;
  let pagesProcessed = 0;

  do {
    const listRes = await listMessages(gmail, { query: 'in:inbox', maxResults: 200, pageToken });
    if (!listRes.messages?.length) break;

    // Filter out already-cached message IDs
    const newIds = listRes.messages
      .map((m: { id?: string | null }) => m.id!)
      .filter((id: string) => id && !cachedIdSet.has(id));

    if (newIds.length > 0) {
      // Batch fetch metadata (parallel — much faster)
      const messages = await batchGetMessageMetadata(gmail, newIds);

      // Upsert to Supabase
      const rows = messages.map(m => ({
        user_id: userId,
        account_email: accountEmail,
        gmail_id: m.id,
        thread_id: m.threadId || null,
        sender: m.sender || '',
        sender_email: m.senderEmail || '',
        subject: m.subject || '',
        snippet: m.snippet || '',
        date: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
        is_unread: m.isUnread ?? true,
        label_ids: m.labelIds || [],
        cached_at: new Date().toISOString(),
      }));

      for (let i = 0; i < rows.length; i += 100) {
        await admin.from(TABLES.INBOX_CACHE)
          .upsert(rows.slice(i, i + 100), { onConflict: 'user_id,account_email,gmail_id' });
      }

      totalCached += messages.length;
      messages.forEach(m => cachedIdSet.add(m.id));
    }

    pageToken = listRes.nextPageToken || undefined;
    pagesProcessed++;

    // Safety: don't exceed max
    if (totalCached >= maxMessages) break;
    // Safety: don't run forever (500 pages = 100k messages)
    if (pagesProcessed >= 500) break;

  } while (pageToken);

  // Update sync metadata
  await admin.from(TABLES.INBOX_SYNC).upsert({
    user_id: userId, account_email: accountEmail,
    last_synced_at: new Date().toISOString(), total_cached: totalCached,
  }, { onConflict: 'user_id,account_email' });

  return { cached: totalCached, total: totalInbox };
}

/**
 * Get exact message counts for a label (e.g. INBOX).
 * Returns { messagesTotal, messagesUnread } — accurate, single API call.
 */
export async function getLabelInfo(gmail: gmail_v1.Gmail, labelId: string = 'INBOX') {
  const res = await gmail.users.labels.get({ userId: 'me', id: labelId });
  return {
    messagesTotal: res.data.messagesTotal || 0,
    messagesUnread: res.data.messagesUnread || 0,
  };
}

// ============ MODIFY OPERATIONS ============

export async function modifyMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  addLabelIds: string[] = [],
  removeLabelIds: string[] = []
) {
  const res = await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
  return res.data;
}

export async function archiveMessage(gmail: gmail_v1.Gmail, messageId: string) {
  return modifyMessage(gmail, messageId, [], ['INBOX']);
}

export async function trashMessage(gmail: gmail_v1.Gmail, messageId: string) {
  const res = await gmail.users.messages.trash({ userId: 'me', id: messageId });
  return res.data;
}

export async function untrashMessage(gmail: gmail_v1.Gmail, messageId: string) {
  const res = await gmail.users.messages.untrash({ userId: 'me', id: messageId });
  return res.data;
}

export async function deleteMessage(gmail: gmail_v1.Gmail, messageId: string) {
  // Permanent delete — use with caution
  await gmail.users.messages.delete({ userId: 'me', id: messageId });
}

export async function markAsRead(gmail: gmail_v1.Gmail, messageId: string) {
  return modifyMessage(gmail, messageId, [], ['UNREAD']);
}

export async function markAsUnread(gmail: gmail_v1.Gmail, messageId: string) {
  return modifyMessage(gmail, messageId, ['UNREAD'], []);
}

export async function starMessage(gmail: gmail_v1.Gmail, messageId: string) {
  return modifyMessage(gmail, messageId, ['STARRED'], []);
}

export async function unstarMessage(gmail: gmail_v1.Gmail, messageId: string) {
  return modifyMessage(gmail, messageId, [], ['STARRED']);
}

// ============ BATCH MODIFY ============

export async function batchModify(
  gmail: gmail_v1.Gmail,
  messageIds: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = []
) {
  // Gmail batchModify supports up to 1000 IDs per call — chunk if needed
  for (let i = 0; i < messageIds.length; i += 1000) {
    const chunk = messageIds.slice(i, i + 1000);
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: { ids: chunk, addLabelIds, removeLabelIds },
    });
  }
}

export async function batchArchive(gmail: gmail_v1.Gmail, messageIds: string[]) {
  return batchModify(gmail, messageIds, [], ['INBOX']);
}

export async function batchTrash(gmail: gmail_v1.Gmail, messageIds: string[]) {
  // Use batchModify to add TRASH label — 1 API call per 1000 messages instead of per-message
  return batchModify(gmail, messageIds, ['TRASH'], ['INBOX']);
}

export async function batchDelete(gmail: gmail_v1.Gmail, messageIds: string[]) {
  // Gmail has no batch delete — must delete individually but in controlled chunks
  for (let i = 0; i < messageIds.length; i += 50) {
    const chunk = messageIds.slice(i, i + 50);
    await Promise.all(chunk.map((id) => deleteMessage(gmail, id)));
    // Brief pause between chunks to avoid quota spikes
    if (i + 50 < messageIds.length) await new Promise(r => setTimeout(r, 1000));
  }
}

// ============ COMPOSE OPERATIONS ============

export async function sendEmail(
  gmail: gmail_v1.Gmail,
  options: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    bcc?: string;
    inReplyTo?: string;
    threadId?: string;
  }
) {
  const messageParts = [
    `To: ${options.to}`,
    options.cc ? `Cc: ${options.cc}` : '',
    options.bcc ? `Bcc: ${options.bcc}` : '',
    `Subject: ${options.subject}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : '',
    options.inReplyTo ? `References: ${options.inReplyTo}` : '',
    'Content-Type: text/html; charset=utf-8',
    '',
    options.body,
  ]
    .filter(Boolean)
    .join('\r\n');

  const raw = Buffer.from(messageParts).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: options.threadId },
  });
  return res.data;
}

export async function createDraft(
  gmail: gmail_v1.Gmail,
  options: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    inReplyTo?: string;
    threadId?: string;
  }
): Promise<GmailDraft> {
  const messageParts = [
    `To: ${options.to}`,
    options.cc ? `Cc: ${options.cc}` : '',
    `Subject: ${options.subject}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : '',
    options.inReplyTo ? `References: ${options.inReplyTo}` : '',
    'Content-Type: text/html; charset=utf-8',
    '',
    options.body,
  ]
    .filter(Boolean)
    .join('\r\n');

  const raw = Buffer.from(messageParts).toString('base64url');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw, threadId: options.threadId },
    },
  });

  return {
    id: res.data.id!,
    messageId: res.data.message?.id || '',
    to: options.to,
    subject: options.subject,
    body: options.body,
  };
}

export async function updateDraft(
  gmail: gmail_v1.Gmail,
  draftId: string,
  options: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }
) {
  const messageParts = [
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    options.body,
  ].join('\r\n');

  const raw = Buffer.from(messageParts).toString('base64url');

  const res = await gmail.users.drafts.update({
    userId: 'me',
    id: draftId,
    requestBody: {
      message: { raw, threadId: options.threadId },
    },
  });
  return res.data;
}

export async function deleteDraft(gmail: gmail_v1.Gmail, draftId: string) {
  await gmail.users.drafts.delete({ userId: 'me', id: draftId });
}

export async function listDrafts(gmail: gmail_v1.Gmail, maxResults = 20) {
  const res = await gmail.users.drafts.list({
    userId: 'me',
    maxResults,
  });
  return res.data.drafts || [];
}

// ============ EXECUTE ACTIONS (for batch operations from the dashboard) ============

export async function executeAction(gmail: gmail_v1.Gmail, action: GmailAction) {
  switch (action.type) {
    case 'archive':
      return batchArchive(gmail, action.messageIds);
    case 'trash':
      return batchTrash(gmail, action.messageIds);
    case 'delete':
      // Permanent deletes one by one
      return Promise.all(action.messageIds.map((id) => deleteMessage(gmail, id)));
    case 'markRead':
      return batchModify(gmail, action.messageIds, [], ['UNREAD']);
    case 'markUnread':
      return batchModify(gmail, action.messageIds, ['UNREAD'], []);
    case 'star':
      return batchModify(gmail, action.messageIds, ['STARRED'], []);
    case 'unstar':
      return batchModify(gmail, action.messageIds, [], ['STARRED']);
    case 'addLabel':
      return batchModify(gmail, action.messageIds, [action.labelId], []);
    case 'removeLabel':
      return batchModify(gmail, action.messageIds, [], [action.labelId]);
  }
}
