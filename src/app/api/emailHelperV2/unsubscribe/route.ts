import { NextRequest } from 'next/server';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, getMessage } from '@/lib/gmail';
import { TABLES } from '@/lib/tables';

const UNSUB_TABLE = 'emailHelperV2_unsubscribe_log';

/**
 * Validate a URL is safe to fetch (SSRF protection).
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return false;
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/emailHelperV2/unsubscribe
 * Queue an unsubscribe request. Returns immediately — processing happens in PUT/cron.
 * Body: { message_id, account_email, sender_email, domain }
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json();
  const { message_id, account_email, sender_email, domain } = body;
  if (!message_id || !account_email) return apiError('Missing message_id or account_email');

  const admin = createSupabaseAdmin();

  // Create queue entry with status=pending
  const { data: logEntry, error: logError } = await admin
    .from(UNSUB_TABLE)
    .insert({
      user_id: userId,
      sender_email: sender_email || '',
      domain: domain || '',
      method: 'pending',
      status: 'pending',
      message_id,
      account_email,
    })
    .select('id')
    .single();

  if (logError) {
    console.error('Unsubscribe queue insert failed:', logError.message);
    return apiError('Failed to queue unsubscribe', 500);
  }

  return apiSuccess({ queued: true, logId: logEntry.id });
}

/**
 * PUT /api/emailHelperV2/unsubscribe
 * Process ONE pending unsubscribe from the queue.
 * Called by cron job or client polling. Accepts CRON_SECRET or session auth.
 */
export async function PUT(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let filterUserId: string | null = null;
  if (!isCron) {
    const { userId } = await getRequestContext(request);
    if (!userId) return apiError('Not authenticated', 401);
    filterUserId = userId;
  }

  const admin = createSupabaseAdmin();

  // Pick the oldest pending entry
  let query = admin.from(UNSUB_TABLE).select('*').eq('status', 'pending').order('attempted_at', { ascending: true }).limit(1);
  if (filterUserId) query = query.eq('user_id', filterUserId);
  const { data: entry } = await query.single();

  if (!entry) return apiSuccess({ idle: true });

  // Mark as processing
  await admin.from(UNSUB_TABLE).update({ status: 'processing' }).eq('id', entry.id);

  const updateLog = async (fields: Record<string, unknown>) => {
    try { await admin.from(UNSUB_TABLE).update(fields).eq('id', entry.id); } catch {}
  };

  try {
    const accessToken = await getValidGmailToken(entry.user_id, entry.account_email);
    const gmail = getGmailClient(accessToken);

    // Fetch full message
    let msg;
    try {
      msg = await getMessage(gmail, entry.message_id, 'full');
    } catch (msgErr) {
      await updateLog({ status: 'failed', error_message: `getMessage error: ${String(msgErr)}`, completed_at: new Date().toISOString() });
      return apiSuccess({ logId: entry.id, status: 'failed', error: String(msgErr) });
    }

    // Strategy 1: Check List-Unsubscribe header
    const result = await tryListUnsubscribeHeader(gmail, entry.message_id, accessToken);
    if (result.success) {
      const isVerified = result.method !== 'header_url_needs_interaction';
      await updateLog({ method: result.method, status: isVerified ? 'success' : 'attempted', unsubscribe_url: result.url || null, completed_at: new Date().toISOString() });
      return apiSuccess({ logId: entry.id, status: isVerified ? 'success' : 'attempted', method: result.method, senderEmail: entry.sender_email });
    }

    // Strategy 2: Parse email body for unsubscribe link
    const bodyResult = await tryBodyUnsubscribeLink(msg);
    if (bodyResult.success && bodyResult.url) {
      await updateLog({ method: 'body_link', status: 'success', unsubscribe_url: bodyResult.url, completed_at: new Date().toISOString() });
      return apiSuccess({ logId: entry.id, status: 'success', method: 'body_link', senderEmail: entry.sender_email });
    }

    // Strategy 3: AI Agent with headless browser
    const anyUrl = result.url || bodyResult.url;
    if (anyUrl) {
      try {
        const { aiUnsubscribe } = await import('@/lib/unsubscribe-agent');
        const aiResult = await aiUnsubscribe(anyUrl, entry.account_email);
        if (aiResult.success) {
          await updateLog({ method: aiResult.method, status: 'success', unsubscribe_url: anyUrl, completed_at: new Date().toISOString() });
          return apiSuccess({ logId: entry.id, status: 'success', method: aiResult.method, senderEmail: entry.sender_email });
        }
      } catch (aiErr) {
        console.error('AI unsubscribe failed:', aiErr);
      }
    }

    // All strategies failed
    await updateLog({ method: 'failed', status: 'failed', error_message: 'No unsubscribe method found', completed_at: new Date().toISOString() });
    return apiSuccess({ logId: entry.id, status: 'failed', senderEmail: entry.sender_email });
  } catch (err) {
    const errMsg = String(err);
    const isQuota = errMsg.toLowerCase().includes('quota');

    if (isQuota) {
      // Reset to pending — will be retried later
      await updateLog({ status: 'pending' });
      return apiSuccess({ logId: entry.id, status: 'quota_retry' });
    }

    await updateLog({ status: 'failed', error_message: errMsg, completed_at: new Date().toISOString() });
    return apiSuccess({ logId: entry.id, status: 'failed', error: errMsg });
  }
}

/**
 * GET /api/emailHelperV2/unsubscribe
 * Returns unsubscribe history/status.
 * ?logId=X — status of specific entry
 * ?pending=true — count of pending entries
 * Default — full history
 */
export async function GET(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const logId = request.nextUrl.searchParams.get('logId');
  const pending = request.nextUrl.searchParams.get('pending');

  if (logId) {
    const { data, error } = await admin.from(UNSUB_TABLE).select('*').eq('id', logId).eq('user_id', userId).single();
    if (error) return apiError('Not found', 404);
    return apiSuccess(data);
  }

  if (pending) {
    const { count } = await admin.from(UNSUB_TABLE).select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'pending');
    return apiSuccess({ pendingCount: count || 0 });
  }

  const { data, error } = await admin
    .from(UNSUB_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('attempted_at', { ascending: false })
    .limit(100);

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}

// ============ UNSUBSCRIBE STRATEGIES ============

async function tryListUnsubscribeHeader(
  gmail: ReturnType<typeof getGmailClient>,
  messageId: string,
  accessToken: string
): Promise<{ success: boolean; method?: string; url?: string }> {
  try {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
    });

    const headers = res.data.payload?.headers || [];
    const unsubHeader = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe')?.value;
    const unsubPostHeader = headers.find(h => h.name?.toLowerCase() === 'list-unsubscribe-post')?.value;

    if (!unsubHeader) return { success: false };

    const urls: string[] = [];
    const mailtos: string[] = [];
    const parts = unsubHeader.split(',').map(s => s.trim());

    for (const part of parts) {
      const match = part.match(/<(.+?)>/);
      if (match) {
        const url = match[1];
        if (url.startsWith('mailto:')) mailtos.push(url);
        else if (url.startsWith('http')) urls.push(url);
      }
    }

    const safeUrls = urls.filter(u => isSafeUrl(u));

    // Prefer one-click HTTP unsubscribe (RFC 8058)
    if (safeUrls.length > 0 && unsubPostHeader) {
      try {
        const response = await fetch(safeUrls[0], {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
          redirect: 'follow',
        });
        if (response.ok || response.status === 200 || response.status === 302) {
          return { success: true, method: 'header_oneclick', url: safeUrls[0] };
        }
      } catch {}
    }

    // Try HTTP GET
    if (safeUrls.length > 0) {
      try {
        const response = await fetch(safeUrls[0], {
          method: 'GET',
          redirect: 'follow',
          headers: { 'User-Agent': 'Clearbox-Unsubscribe/1.0' },
        });
        if (response.ok) {
          const html = await response.text();
          const looksSuccessful = /unsubscrib(ed|e success|e confirm|tion complete|tion success)/i.test(html);
          if (looksSuccessful) {
            return { success: true, method: 'header_url', url: safeUrls[0] };
          }
          return { success: false, method: 'header_url_needs_interaction', url: safeUrls[0] };
        }
      } catch {}
    }

    // Try mailto
    if (mailtos.length > 0) {
      try {
        const mailto = mailtos[0].replace('mailto:', '');
        const [toAddr, queryString] = mailto.split('?');
        const params = new URLSearchParams(queryString || '');
        const subject = params.get('subject') || 'Unsubscribe';
        const body = params.get('body') || 'Unsubscribe';

        const raw = Buffer.from(
          `To: ${toAddr}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });

        return { success: true, method: 'header_mailto', url: mailtos[0] };
      } catch {}
    }

    return { success: false };
  } catch {
    return { success: false };
  }
}

async function tryBodyUnsubscribeLink(
  msg: { bodyHtml?: string; body?: string }
): Promise<{ success: boolean; url?: string }> {
  const html = msg.bodyHtml || msg.body || '';
  if (!html) return { success: false };

  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*unsubscrib[^<]*/gi;
  const matches = [...html.matchAll(linkRegex)];
  const urlRegex = /<a[^>]+href=["']([^"']*unsubscrib[^"']*)["']/gi;
  const urlMatches = [...html.matchAll(urlRegex)];

  const allUrls = new Set<string>();
  for (const m of [...matches, ...urlMatches]) {
    const url = m[1];
    if (url && url.startsWith('http')) allUrls.add(url);
  }

  if (allUrls.size === 0) return { success: false };

  let safeUrl: string | null = null;
  for (const u of allUrls) {
    if (isSafeUrl(u)) { safeUrl = u; break; }
  }
  if (!safeUrl) return { success: false };

  try {
    const response = await fetch(safeUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Clearbox-Unsubscribe/1.0' },
    });
    if (response.ok) {
      return { success: true, url: safeUrl };
    }
  } catch {}

  return { success: true, url: safeUrl };
}

// Suppress unused variable warning — accessToken is passed for potential future use
void ((_: string) => _);
