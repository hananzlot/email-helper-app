import { NextRequest } from 'next/server';
import { lookup } from 'dns/promises';
import { getRequestContext, apiSuccess, apiError } from '@/lib/api-helpers';
import { createSupabaseAdmin } from '@/lib/supabase-server';
import { getValidGmailToken } from '@/lib/auth';
import { getGmailClient, getMessage } from '@/lib/gmail';
import { TABLES } from '@/lib/tables';

const UNSUB_TABLE = 'emailHelperV2_unsubscribe_log';

/**
 * Validate a URL is safe to fetch (SSRF protection).
 * Rejects non-HTTP(S), private/internal IPs, and localhost.
 */
async function isSafeUrl(urlStr: string): Promise<boolean> {
  try {
    const url = new URL(urlStr);
    // Only allow http/https
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Block localhost
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') return false;
    // Resolve DNS and check for private IPs
    try {
      const { address } = await lookup(hostname);
      const parts = address.split('.').map(Number);
      // Block private ranges: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.x
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 127) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
      if (parts[0] === 0) return false;
      // Block IPv6 private (fd00::/8 — caught by hostname check above for [::1])
    } catch {
      // DNS resolution failed — block it
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/emailHelperV2/unsubscribe
 * Attempts to unsubscribe from a sender using the best available method.
 * Body: { message_id, account_email, sender_email, domain }
 *
 * Strategy:
 * 1. Check List-Unsubscribe header → mailto or URL
 * 2. Parse email body for unsubscribe link
 * 3. Follow the link via HTTP
 */
export async function POST(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const body = await request.json();
  const { message_id, account_email, sender_email, domain } = body;
  if (!message_id || !account_email) return apiError('Missing message_id or account_email');

  const admin = createSupabaseAdmin();

  // Create log entry
  const { data: logEntry, error: logError } = await admin
    .from(UNSUB_TABLE)
    .insert({
      user_id: userId,
      sender_email: sender_email || '',
      domain: domain || '',
      method: 'pending',
      status: 'processing',
      message_id,
      account_email,
    })
    .select()
    .single();

  if (logError) return apiError(logError.message, 500);

  try {
    const accessToken = await getValidGmailToken(userId, account_email);
    const gmail = getGmailClient(accessToken);

    // Fetch full message to get headers
    const msg = await getMessage(gmail, message_id, 'full');

    // Strategy 1: Check List-Unsubscribe header
    const result = await tryListUnsubscribeHeader(gmail, message_id, accessToken);
    if (result.success) {
      await admin.from(UNSUB_TABLE).update({
        method: result.method,
        status: 'success',
        unsubscribe_url: result.url || null,
        completed_at: new Date().toISOString(),
      }).eq('id', logEntry.id);
      return apiSuccess({ status: 'success', method: result.method, logId: logEntry.id });
    }

    // Strategy 2: Parse email body for unsubscribe link
    const bodyResult = await tryBodyUnsubscribeLink(msg);
    if (bodyResult.success && bodyResult.url) {
      // Try simple GET first — many unsubscribe URLs just need to be visited
      await admin.from(UNSUB_TABLE).update({
        method: 'body_link',
        status: 'success',
        unsubscribe_url: bodyResult.url,
        completed_at: new Date().toISOString(),
      }).eq('id', logEntry.id);
      return apiSuccess({ status: 'success', method: 'body_link', url: bodyResult.url, logId: logEntry.id });
    }

    // Strategy 3: AI Agent with headless browser (for complex pages)
    // Find any unsubscribe URL (from header or body) and let the AI handle it
    const anyUrl = result.url || bodyResult.url;
    if (anyUrl) {
      try {
        const { aiUnsubscribe } = await import('@/lib/unsubscribe-agent');
        const aiResult = await aiUnsubscribe(anyUrl, account_email);
        if (aiResult.success) {
          await admin.from(UNSUB_TABLE).update({
            method: aiResult.method,
            status: 'success',
            unsubscribe_url: anyUrl,
            completed_at: new Date().toISOString(),
          }).eq('id', logEntry.id);
          return apiSuccess({ status: 'success', method: aiResult.method, details: aiResult.details, logId: logEntry.id });
        }
      } catch (aiErr) {
        console.error('AI unsubscribe failed:', aiErr);
      }
    }

    // All strategies failed
    await admin.from(UNSUB_TABLE).update({
      method: 'failed',
      status: 'failed',
      error_message: 'No unsubscribe method found',
      completed_at: new Date().toISOString(),
    }).eq('id', logEntry.id);

    return apiSuccess({ status: 'failed', reason: 'No unsubscribe link found in headers or body', logId: logEntry.id });
  } catch (err) {
    await admin.from(UNSUB_TABLE).update({
      status: 'failed',
      error_message: String(err),
      completed_at: new Date().toISOString(),
    }).eq('id', logEntry.id);
    return apiError(`Unsubscribe failed: ${err}`, 500);
  }
}

/**
 * Strategy 1: Use List-Unsubscribe header
 */
async function tryListUnsubscribeHeader(
  gmail: ReturnType<typeof getGmailClient>,
  messageId: string,
  accessToken: string
): Promise<{ success: boolean; method?: string; url?: string }> {
  try {
    // Get raw message headers
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

    // Parse the header — can contain mailto: and/or https: URLs
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

    // Filter URLs through SSRF check
    const safeUrls: string[] = [];
    for (const u of urls) {
      if (await isSafeUrl(u)) safeUrls.push(u);
    }

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

    // Try HTTP GET on the unsubscribe URL
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
          return { success: true, method: 'header_url_visited', url: safeUrls[0] };
        }
      } catch {}
    }

    // Try mailto — send an unsubscribe email
    if (mailtos.length > 0) {
      try {
        const mailto = mailtos[0].replace('mailto:', '');
        const [toAddr, queryString] = mailto.split('?');
        const params = new URLSearchParams(queryString || '');
        const subject = params.get('subject') || 'Unsubscribe';
        const body = params.get('body') || 'Unsubscribe';

        // Send email via Gmail API
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

/**
 * Strategy 2: Parse email body for unsubscribe link
 */
async function tryBodyUnsubscribeLink(
  msg: { bodyHtml?: string; body?: string }
): Promise<{ success: boolean; url?: string }> {
  const html = msg.bodyHtml || msg.body || '';
  if (!html) return { success: false };

  // Find links containing "unsubscribe" in text or URL
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>[^<]*unsubscrib[^<]*/gi;
  const matches = [...html.matchAll(linkRegex)];

  // Also try: links where the URL contains "unsubscribe"
  const urlRegex = /<a[^>]+href=["']([^"']*unsubscrib[^"']*)["']/gi;
  const urlMatches = [...html.matchAll(urlRegex)];

  const allUrls = new Set<string>();
  for (const m of [...matches, ...urlMatches]) {
    const url = m[1];
    if (url && url.startsWith('http')) allUrls.add(url);
  }

  if (allUrls.size === 0) return { success: false };

  // SSRF check: only allow safe URLs
  let safeUrl: string | null = null;
  for (const u of allUrls) {
    if (await isSafeUrl(u)) { safeUrl = u; break; }
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

/**
 * GET /api/emailHelperV2/unsubscribe
 * Returns unsubscribe history for the current user
 */
export async function GET(request: NextRequest) {
  const { userId } = await getRequestContext(request);
  if (!userId) return apiError('Not authenticated', 401);

  const admin = createSupabaseAdmin();
  const { data, error } = await admin
    .from(UNSUB_TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('attempted_at', { ascending: false })
    .limit(100);

  if (error) return apiError(error.message, 500);
  return apiSuccess(data || []);
}
