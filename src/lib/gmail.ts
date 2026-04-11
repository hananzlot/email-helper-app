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
  await gmail.users.messages.batchModify({
    userId: 'me',
    requestBody: { ids: messageIds, addLabelIds, removeLabelIds },
  });
}

export async function batchArchive(gmail: gmail_v1.Gmail, messageIds: string[]) {
  return batchModify(gmail, messageIds, [], ['INBOX']);
}

export async function batchTrash(gmail: gmail_v1.Gmail, messageIds: string[]) {
  // Gmail doesn't have a batch trash endpoint, so we use individual calls
  await Promise.all(messageIds.map((id) => trashMessage(gmail, id)));
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
