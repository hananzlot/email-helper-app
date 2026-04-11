import { NextRequest } from 'next/server';
import { getGmailFromRequest, apiSuccess, apiError } from '@/lib/api-helpers';
import * as gmail from '@/lib/gmail';

/**
 * GET /api/emailHelperV2/gmail?action=inbox&account=user@example.com
 *
 * Supported actions:
 *   - profile: Get Gmail profile
 *   - inbox: List inbox messages (optional: ?q=search&max=20)
 *   - message: Get a single message (?id=MSG_ID&format=full|metadata)
 *   - thread: Get a thread (?id=THREAD_ID)
 *   - search: Search messages (?q=query&max=20)
 *   - labels: List all labels
 *   - drafts: List drafts
 */
export async function GET(request: NextRequest) {
  const result = await getGmailFromRequest(request);
  if ('error' in result) return apiError(result.error, 401);
  const { gmail: client } = result;

  const action = request.nextUrl.searchParams.get('action') || 'inbox';
  const id = request.nextUrl.searchParams.get('id');
  const query = request.nextUrl.searchParams.get('q') || '';
  const maxResults = parseInt(request.nextUrl.searchParams.get('max') || '20');
  const format = (request.nextUrl.searchParams.get('format') || 'metadata') as 'full' | 'metadata' | 'minimal';
  const pageToken = request.nextUrl.searchParams.get('pageToken') || undefined;

  try {
    switch (action) {
      case 'profile':
        return apiSuccess(await gmail.getProfile(client));

      case 'inbox':
        const inboxMessages = await gmail.listMessages(client, {
          query: query || 'in:inbox',
          maxResults,
          pageToken,
        });
        // Fetch metadata for each message
        const inboxDetails = await Promise.all(
          inboxMessages.messages.map((m) => gmail.getMessage(client, m.id!, 'metadata'))
        );
        return apiSuccess({
          messages: inboxDetails,
          nextPageToken: inboxMessages.nextPageToken,
          total: inboxMessages.resultSizeEstimate,
        });

      case 'message':
        if (!id) return apiError('Missing message id');
        return apiSuccess(await gmail.getMessage(client, id, format));

      case 'thread':
        if (!id) return apiError('Missing thread id');
        return apiSuccess(await gmail.getThread(client, id));

      case 'search':
        const searchResults = await gmail.listMessages(client, { query, maxResults, pageToken });
        const searchDetails = await Promise.all(
          searchResults.messages.map((m) => gmail.getMessage(client, m.id!, 'metadata'))
        );
        return apiSuccess({
          messages: searchDetails,
          nextPageToken: searchResults.nextPageToken,
          total: searchResults.resultSizeEstimate,
        });

      case 'labels':
        return apiSuccess(await gmail.listLabels(client));

      case 'drafts':
        return apiSuccess(await gmail.listDrafts(client, maxResults));

      case 'attachment': {
        if (!id) return apiError('Missing message id');
        const attId = request.nextUrl.searchParams.get('attachmentId');
        if (!attId) return apiError('Missing attachmentId');
        const attData = await gmail.getAttachment(client, id, attId);
        return apiSuccess(attData);
      }

      default:
        return apiError(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error(`Gmail GET error (${action}):`, err);
    return apiError(`Gmail operation failed: ${err}`, 500);
  }
}

/**
 * POST /api/emailHelperV2/gmail
 *
 * Body: { action: string, account: string, ...params }
 *
 * Supported actions:
 *   - archive: { messageIds: string[] }
 *   - trash: { messageIds: string[] }
 *   - delete: { messageIds: string[] }
 *   - markRead: { messageIds: string[] }
 *   - markUnread: { messageIds: string[] }
 *   - star: { messageIds: string[] }
 *   - unstar: { messageIds: string[] }
 *   - addLabel: { messageIds: string[], labelId: string }
 *   - removeLabel: { messageIds: string[], labelId: string }
 *   - send: { to, subject, body, cc?, bcc?, inReplyTo?, threadId? }
 *   - createDraft: { to, subject, body, cc?, inReplyTo?, threadId? }
 *   - updateDraft: { draftId, to, subject, body, threadId? }
 *   - deleteDraft: { draftId }
 */
export async function POST(request: NextRequest) {
  const result = await getGmailFromRequest(request);
  if ('error' in result) return apiError(result.error, 401);
  const { gmail: client } = result;

  try {
    const body = await request.json();
    const { action, ...params } = body;

    switch (action) {
      // Modify operations
      case 'archive':
        await gmail.batchArchive(client, params.messageIds);
        return apiSuccess({ archived: params.messageIds.length });

      case 'trash':
        await gmail.batchTrash(client, params.messageIds);
        return apiSuccess({ trashed: params.messageIds.length });

      case 'delete':
        await Promise.all(params.messageIds.map((id: string) => gmail.deleteMessage(client, id)));
        return apiSuccess({ deleted: params.messageIds.length });

      case 'markRead':
        await gmail.batchModify(client, params.messageIds, [], ['UNREAD']);
        return apiSuccess({ markedRead: params.messageIds.length });

      case 'markUnread':
        await gmail.batchModify(client, params.messageIds, ['UNREAD'], []);
        return apiSuccess({ markedUnread: params.messageIds.length });

      case 'star':
        await gmail.batchModify(client, params.messageIds, ['STARRED'], []);
        return apiSuccess({ starred: params.messageIds.length });

      case 'unstar':
        await gmail.batchModify(client, params.messageIds, [], ['STARRED']);
        return apiSuccess({ unstarred: params.messageIds.length });

      case 'addLabel':
        await gmail.batchModify(client, params.messageIds, [params.labelId], []);
        return apiSuccess({ labeled: params.messageIds.length });

      case 'removeLabel':
        await gmail.batchModify(client, params.messageIds, [], [params.labelId]);
        return apiSuccess({ unlabeled: params.messageIds.length });

      // Compose operations
      case 'send':
        const sent = await gmail.sendEmail(client, params);
        return apiSuccess(sent);

      case 'createDraft':
        const draft = await gmail.createDraft(client, params);
        return apiSuccess(draft);

      case 'updateDraft':
        const updated = await gmail.updateDraft(client, params.draftId, params);
        return apiSuccess(updated);

      case 'deleteDraft':
        await gmail.deleteDraft(client, params.draftId);
        return apiSuccess({ deleted: true });

      default:
        return apiError(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error('Gmail POST error:', err);
    return apiError(`Gmail operation failed: ${err}`, 500);
  }
}
