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

      case 'labelInfo': {
        const labelId = request.nextUrl.searchParams.get('labelId') || 'INBOX';
        return apiSuccess(await gmail.getLabelInfo(client, labelId));
      }

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
    console.error('Gmail operation failed:', err);
    return apiError('Gmail operation failed', 500);
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
  // CSRF: verify Origin header matches our domain
  const origin = request.headers.get('origin');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (origin && appUrl && !appUrl.startsWith(origin)) {
    return apiError('Cross-origin request blocked', 403);
  }

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
        await gmail.batchDelete(client, params.messageIds);
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
    const errStr = String(err);
    // If "not found" — the message might belong to a different connected account
    // Try all other accounts before giving up
    if (errStr.includes('not found') || errStr.includes('Not Found') || errStr.includes('notFound')) {
      const body = await request.clone().json().catch(() => null);
      if (body) {
        const { getRequestContext: getCtx } = await import('@/lib/api-helpers');
        const { userId } = await getCtx(request);
        if (userId) {
          const { createSupabaseAdmin } = await import('@/lib/supabase-server');
          const { TABLES } = await import('@/lib/tables');
          const { getValidGmailToken } = await import('@/lib/auth');
          const admin = createSupabaseAdmin();
          const { data: accounts } = await admin
            .from(TABLES.GMAIL_ACCOUNTS)
            .select('email')
            .eq('user_id', userId)
            .eq('status', 'connected');

          const currentAccount = request.nextUrl.searchParams.get('account');
          const otherAccounts = (accounts || []).filter((a: { email: string }) => a.email !== currentAccount);

          for (const acct of otherAccounts) {
            try {
              const token = await getValidGmailToken(userId, acct.email);
              const altClient = gmail.getGmailClient(token);
              const { action: act, ...params } = body;
              switch (act) {
                case 'archive': await gmail.batchArchive(altClient, params.messageIds); break;
                case 'trash': await gmail.batchTrash(altClient, params.messageIds); break;
                case 'delete': await Promise.all(params.messageIds.map((id: string) => gmail.deleteMessage(altClient, id))); break;
                case 'markRead': await gmail.batchModify(altClient, params.messageIds, [], ['UNREAD']); break;
                case 'markUnread': await gmail.batchModify(altClient, params.messageIds, ['UNREAD'], []); break;
                case 'star': await gmail.batchModify(altClient, params.messageIds, ['STARRED'], []); break;
                case 'unstar': await gmail.batchModify(altClient, params.messageIds, [], ['STARRED']); break;
                default: continue;
              }
              console.log(`Gmail POST: action ${act} succeeded on fallback account ${acct.email}`);
              return apiSuccess({ [act]: params.messageIds?.length || 1, fallbackAccount: acct.email });
            } catch {
              continue; // Try next account
            }
          }
        }
      }
    }
    console.error('Gmail POST error:', err);
    console.error('Gmail operation failed:', err);
    return apiError('Gmail operation failed', 500);
  }
}
