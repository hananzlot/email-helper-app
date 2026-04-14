import { gmail_v1 } from 'googleapis';
import * as gmail from './gmail';
import { createSupabaseAdmin } from './supabase-server';
import { TABLES } from './tables';
import { encryptFields, decryptFields, encryptJson, ENCRYPTED_FIELDS } from './crypto';
import type { GmailMessage, TriagedEmail, TriageResult, Priority, SenderTier } from '@/types';

// ============ TRIAGE ENGINE ============

interface SenderData {
  sender_email: string;
  display_name: string;
  reply_count: number;
  tier: SenderTier;
  auto_archive_updates?: boolean;
}

interface RuleData {
  pattern: string;
  category: string;
  description: string;
  default_priority: number;
  user_priority: number | null;
}

/**
 * Run a full inbox triage for a user's Gmail account.
 *
 * 1. Fetch unread inbox messages
 * 2. Look up each sender in the priority table
 * 3. Apply notification rules to automated emails
 * 4. Categorize into priority buckets
 * 5. Store results in Supabase
 */
export async function runTriage(
  client: gmail_v1.Gmail,
  userId: string,
  accountEmail: string
): Promise<TriageResult> {
  const admin = createSupabaseAdmin();

  // Load sender priorities and notification rules in parallel
  const [sendersRes, rulesRes, inboxData] = await Promise.all([
    admin
      .from(TABLES.SENDER_PRIORITIES)
      .select('sender_email, display_name, reply_count, tier, auto_archive_updates')
      .eq('user_id', userId),
    admin
      .from(TABLES.NOTIFICATION_RULES)
      .select('pattern, category, description, default_priority, user_priority')
      .eq('user_id', userId),
    gmail.listMessages(client, {
      query: 'in:inbox is:unread',
      maxResults: 50,
    }),
  ]);

  const senders: Record<string, SenderData> = {};
  (sendersRes.data || []).forEach((s: SenderData) => {
    // Decrypt display_name (sender_email is not encrypted, used as lookup key)
    const decrypted = decryptFields(s as unknown as Record<string, unknown>, [...ENCRYPTED_FIELDS.SENDER_PRIORITIES], userId) as unknown as SenderData;
    senders[decrypted.sender_email.toLowerCase()] = decrypted;
  });

  const rules: RuleData[] = rulesRes.data || [];

  // Fetch full metadata for each message
  const messages: GmailMessage[] = await Promise.all(
    (inboxData.messages || []).map((m) =>
      gmail.getMessage(client, m.id!, 'metadata')
    )
  );

  // Score and categorize each email
  const triaged: TriagedEmail[] = messages.map((msg) => {
    const senderEmail = msg.senderEmail.toLowerCase();
    const senderData = senders[senderEmail];
    const tier = senderData?.tier || 'N/A';

    // Calculate priority score (0-10)
    const score = calculatePriorityScore(msg, senderData, rules);
    const priority = scoreToPriority(score);

    // Build Gmail URL
    const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${msg.id}`;

    return {
      id: msg.id,
      threadId: msg.threadId,
      sender: msg.sender,
      senderEmail: msg.senderEmail,
      subject: msg.subject,
      summary: msg.snippet,
      tier: tier as SenderTier | 'N/A',
      priority,
      priorityScore: score,
      received: msg.date,
      gmailUrl,
      status: 'active' as const,
      account: accountEmail,
    };
  });

  // Sort by priority score (highest first)
  triaged.sort((a, b) => b.priorityScore - a.priorityScore);

  // Categorize
  const replyNeeded = triaged.filter(
    (e) => e.priority === 'urgent' || (e.priority === 'important' && isLikelyNeedsReply(e))
  );
  const importantNotifications = triaged.filter(
    (e) => e.priority === 'important' && !replyNeeded.includes(e)
  );
  const worthReading = triaged.filter((e) => e.priority === 'normal');
  const lowPriority = triaged.filter((e) => e.priority === 'low');

  const result: TriageResult = {
    account: accountEmail,
    triaged_at: new Date().toISOString(),
    total_unread: messages.length,
    categories: {
      reply_needed: replyNeeded,
      important_notifications: importantNotifications,
      worth_reading: worthReading,
      low_priority: lowPriority,
    },
  };

  // Store in Supabase (upsert by user + account) — encrypt the data blob
  await admin.from(TABLES.TRIAGE_RESULTS).upsert(
    {
      user_id: userId,
      account_email: accountEmail,
      triaged_at: result.triaged_at,
      total_unread: result.total_unread,
      data: encryptJson(result, userId), // Encrypted string stored in JSONB as JSON string
    },
    { onConflict: 'user_id,account_email' }
  );

  // Auto-archive update-only messages from high-tier senders with auto_archive_updates enabled
  const autoArchiveIds: string[] = [];
  const remainingTriaged = triaged.filter((e) => {
    const senderEmail = e.senderEmail.toLowerCase();
    const senderData = senders[senderEmail];
    if (
      senderData?.auto_archive_updates &&
      (senderData.tier === 'A' || senderData.tier === 'B' || senderData.tier === 'C') &&
      !isLikelyNeedsReply(e) &&
      e.priority !== 'urgent'
    ) {
      autoArchiveIds.push(e.id);
      return false; // Remove from triage queue
    }
    return true;
  });

  // Auto-archive in Gmail (batch)
  if (autoArchiveIds.length > 0) {
    try {
      for (const msgId of autoArchiveIds) {
        await gmail.archiveMessage(client, msgId);
      }
    } catch (err) {
      console.error('Auto-archive failed:', err);
    }
  }

  // Add signal emails to reply queue. Signal = Tier A/B/C senders + high priority.
  // Noise (Tier D, unknown, automated) stays out — that's for the Cleanup tab.
  const signalEmails = remainingTriaged.filter((e) => {
    // Tier A/B/C senders go to reply queue (Triage tab)
    if (e.tier === 'A' || e.tier === 'B' || e.tier === 'C') return true;
    // Urgent or important priority (high score) go to reply queue
    if (e.priority === 'urgent' || e.priority === 'important') return true;
    // Emails with reply-needed signals go to reply queue
    if (isLikelyNeedsReply(e)) return true;
    return false;
  });

  if (signalEmails.length > 0) {
    // Fetch currently-snoozed message IDs so we don't overwrite them back to active
    const { data: snoozedRows } = await admin
      .from(TABLES.REPLY_QUEUE)
      .select('message_id')
      .eq('user_id', userId)
      .eq('status', 'snoozed');
    const snoozedMessageIds = new Set((snoozedRows || []).map((r: { message_id: string }) => r.message_id));

    const queueItems = signalEmails
      .filter((e) => !snoozedMessageIds.has(e.id))
      .map((e) => {
        const item = {
          user_id: userId,
          message_id: e.id,
          thread_id: e.threadId,
          account_email: accountEmail,
          sender: e.sender,
          sender_email: e.senderEmail,
          subject: e.subject,
          summary: e.summary,
          tier: e.tier,
          priority: e.priority,
          priority_score: e.priorityScore,
          received: new Date(e.received).toISOString(),
          gmail_url: e.gmailUrl,
          status: 'active',
        };
        // Encrypt sensitive fields before storing
        return encryptFields(item, [...ENCRYPTED_FIELDS.REPLY_QUEUE], userId);
      });

    // Batch upsert in chunks of 25 to avoid payload limits
    for (let i = 0; i < queueItems.length; i += 25) {
      const chunk = queueItems.slice(i, i + 25);
      await admin.from(TABLES.REPLY_QUEUE).upsert(chunk, {
        onConflict: 'user_id,message_id',
      });
    }
  }

  return result;
}

// ============ SCORING ============

function calculatePriorityScore(
  msg: GmailMessage,
  senderData: SenderData | undefined,
  rules: RuleData[]
): number {
  let score = 5; // Default baseline

  // Signal 1: Sender tier (based on reply frequency)
  if (senderData) {
    switch (senderData.tier) {
      case 'A': score = 9; break;  // Top 10% — you reply to them a lot
      case 'B': score = 7; break;  // Next 20%
      case 'C': score = 5; break;  // Next 30%
      case 'D': score = 3; break;  // Bottom 40%
    }
  }

  // Signal 2: Notification rules (pattern matching)
  const matchedRule = matchNotificationRule(msg, rules);
  if (matchedRule) {
    const rulePriority = matchedRule.user_priority ?? matchedRule.default_priority;
    // If sender is unknown, use rule priority directly
    // If sender is known, blend: 60% sender score + 40% rule score
    if (!senderData) {
      score = rulePriority;
    } else {
      score = Math.round(score * 0.6 + rulePriority * 0.4);
    }
  }

  // Signal 3: Direct address (To: vs CC:)
  // Emails where you're in CC are less important
  // (We'd need to check headers for this — future enhancement)

  // Signal 4: Recency boost — very recent emails get a small bump
  const emailDate = new Date(msg.date);
  const hoursAgo = (Date.now() - emailDate.getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 2) score = Math.min(10, score + 1);

  // Signal 5: If sender is completely unknown and no rule matches, lower priority
  if (!senderData && !matchedRule) {
    score = Math.max(2, score - 2);
  }

  // Clamp to 0-10
  return Math.max(0, Math.min(10, score));
}

function matchNotificationRule(
  msg: GmailMessage,
  rules: RuleData[]
): RuleData | null {
  const senderLower = msg.senderEmail.toLowerCase();
  const subjectLower = msg.subject.toLowerCase();
  const senderName = msg.sender.toLowerCase();

  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase();

    // Match "from:*@domain.com" patterns
    const fromMatch = pattern.match(/^from:\*@(.+)$/);
    if (fromMatch) {
      if (senderLower.endsWith('@' + fromMatch[1])) return rule;
      continue;
    }

    // Match "from:exact@email.com" patterns
    const fromExact = pattern.match(/^from:(.+)$/);
    if (fromExact) {
      if (senderLower === fromExact[1]) return rule;
      continue;
    }

    // Keyword matching in subject or sender name
    if (
      subjectLower.includes(pattern) ||
      senderName.includes(pattern) ||
      senderLower.includes(pattern)
    ) {
      return rule;
    }
  }

  return null;
}

function scoreToPriority(score: number): Priority {
  if (score >= 8) return 'urgent';
  if (score >= 6) return 'important';
  if (score >= 4) return 'normal';
  return 'low';
}

function isLikelyNeedsReply(email: TriagedEmail): boolean {
  const subject = email.subject.toLowerCase();
  const summary = email.summary.toLowerCase();

  // Heuristics for "needs a reply"
  const replySignals = [
    'please respond',
    'please reply',
    'your thoughts',
    'what do you think',
    'can you',
    'could you',
    'would you',
    'let me know',
    'following up',
    'checking in',
    'action required',
    'action needed',
    'response needed',
    'rsvp',
    'schedule a',
    'set up a',
    'meet',
    'call',
    'question',
    '?', // questions in subject
  ];

  const noReplySignals = [
    'noreply',
    'no-reply',
    'donotreply',
    'do-not-reply',
    'notification',
    'newsletter',
    'unsubscribe',
    'receipt',
    'confirmation',
    'automated',
    'alert',
  ];

  // Check for no-reply sender
  if (noReplySignals.some((s) => email.senderEmail.toLowerCase().includes(s))) {
    return false;
  }

  // Check for reply signals
  if (replySignals.some((s) => subject.includes(s) || summary.includes(s))) {
    return true;
  }

  // High-tier senders likely need replies
  if (email.tier === 'A' || email.tier === 'B') {
    return true;
  }

  return false;
}

// ============ SENT MAIL SCANNER (for learning sender priorities) ============

/**
 * Fast sent-mail scanner. Fetches sent messages in batches and reads the "To"
 * header directly from each message's metadata — no thread fetches needed.
 * Processes up to 200 sent messages (~10 batches of 20), takes ~10-15 seconds.
 */
export interface TierMinimums {
  A: number; // Min replies for Tier A (default 7)
  B: number; // Min replies for Tier B (default 4)
  C: number; // Min replies for Tier C (default 2)
  D: number; // Min replies for Tier D (default 1)
}

export const DEFAULT_TIER_MINIMUMS: TierMinimums = { A: 7, B: 4, C: 2, D: 1 };

export async function scanSentMail(
  client: gmail_v1.Gmail,
  userId: string,
  accountEmail: string,
  tierMinimums?: TierMinimums
): Promise<{ sendersFound: number; totalReplies: number }> {
  const mins = tierMinimums || DEFAULT_TIER_MINIMUMS;
  const admin = createSupabaseAdmin();
  const recipientCounts: Record<string, { name: string; count: number; lastDate: string }> = {};

  let pageToken: string | undefined;
  let totalScanned = 0;
  const MAX_SCAN = 200; // Keep it fast

  while (totalScanned < MAX_SCAN) {
    const batch = await gmail.listMessages(client, {
      query: 'in:sent',
      maxResults: 20,
      pageToken,
    });

    if (!batch.messages || batch.messages.length === 0) break;

    // Fetch metadata for each message in parallel (batch of 20)
    const details = await Promise.all(
      batch.messages.map(async (m) => {
        try {
          const res = await client.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'metadata',
            metadataHeaders: ['To', 'Date'],
          });
          return res.data;
        } catch {
          return null;
        }
      })
    );

    for (const msg of details) {
      if (!msg) continue;
      const headers = msg.payload?.headers || [];
      const toHeader = headers.find(h => h.name?.toLowerCase() === 'to')?.value || '';
      const dateHeader = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';

      // Parse all recipients from the To header (can have multiple)
      const emailMatches = toHeader.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const nameMatches = toHeader.match(/([^<,]+?)\s*<[^>]+>/g) || [];

      // Build a name map from "Name <email>" patterns
      const nameMap: Record<string, string> = {};
      for (const nm of nameMatches) {
        const match = nm.match(/(.+?)\s*<(.+?)>/);
        if (match) {
          nameMap[match[2].toLowerCase()] = match[1].replace(/"/g, '').trim();
        }
      }

      for (const email of emailMatches) {
        const key = email.toLowerCase();
        // Skip self
        if (key === accountEmail.toLowerCase()) continue;

        if (!recipientCounts[key]) {
          recipientCounts[key] = { name: nameMap[key] || key, count: 0, lastDate: '' };
        }
        recipientCounts[key].count++;
        if (dateHeader > recipientCounts[key].lastDate) {
          recipientCounts[key].lastDate = dateHeader;
        }
      }
    }

    totalScanned += batch.messages.length;
    pageToken = batch.nextPageToken || undefined;
    if (!batch.nextPageToken) break;
  }

  // Calculate tiers based on how often you email each person
  const entries = Object.entries(recipientCounts);
  entries.sort((a, b) => b[1].count - a[1].count);

  // Filter out machine-generated addresses (SES, noreply, UUID-like local parts)
  const isGibberishAddress = (email: string): boolean => {
    const local = email.split('@')[0];
    const domain = email.split('@')[1] || '';
    // UUID-like patterns (common in SES, transactional systems)
    if (/[0-9a-f]{8,}-[0-9a-f]{4,}/i.test(local)) return true;
    // Very long local parts with lots of numbers/hyphens (machine-generated)
    if (local.length > 30 && (local.match(/[0-9-]/g) || []).length > local.length * 0.4) return true;
    // Known transactional/noreply patterns in local part
    if (/noreply|no-reply|donotreply|do-not-reply|mailer-daemon/i.test(local)) return true;
    // Bounce/transactional domains
    if (/^bounce\./i.test(domain)) return true;
    if (/amazonses\.com|sendgrid\.net|mailgun\.org|mandrillapp\.com|postmarkapp\.com|constantcontact\.com|mailchimp\.com|cmail\d+\.com|mcsv\.net|mcdlv\.net/i.test(domain)) return true;
    // Local part starting with "bounce" or containing "bounce-"
    if (/^bounce/i.test(local)) return true;
    return false;
  };

  // Load merged/aliased emails — these should not be re-created as separate senders
  const aliasedEmails = new Set<string>();

  // From sender_priorities aliases field
  const { data: existingSenders } = await admin
    .from(TABLES.SENDER_PRIORITIES)
    .select('aliases')
    .eq('user_id', userId);
  if (existingSenders) {
    for (const s of existingSenders) {
      for (const alias of (s.aliases || [])) aliasedEmails.add(alias.toLowerCase());
    }
  }

  // From merge history in action_history (survives across account syncs)
  const { data: mergeHistory } = await admin
    .from(TABLES.ACTION_HISTORY)
    .select('subjects')
    .eq('user_id', userId)
    .eq('action', 'mergeSenders')
    .eq('undone', false);
  if (mergeHistory) {
    for (const m of mergeHistory) {
      for (const email of (m.subjects || [])) aliasedEmails.add(email.toLowerCase());
    }
  }

  // Assign tiers based on reply count thresholds (not percentile position)

  // Load existing sender data to accumulate counts across accounts
  const validEntries = entries.filter(([email]) => !isGibberishAddress(email) && !aliasedEmails.has(email.toLowerCase()));
  const validEmails = validEntries.map(([email]) => email);
  const existingMap: Record<string, { reply_count: number; accounts_seen: string[] }> = {};
  // Fetch in batches of 50
  for (let i = 0; i < validEmails.length; i += 50) {
    const batch = validEmails.slice(i, i + 50);
    const { data: existingBatch } = await admin
      .from(TABLES.SENDER_PRIORITIES)
      .select('sender_email, reply_count, accounts_seen')
      .eq('user_id', userId)
      .in('sender_email', batch);
    if (existingBatch) {
      for (const s of existingBatch) {
        existingMap[s.sender_email.toLowerCase()] = {
          reply_count: s.reply_count || 0,
          accounts_seen: s.accounts_seen || [],
        };
      }
    }
  }

  // Upsert sender priorities — accumulate counts across accounts
  const upserts = validEntries.map(([email, data]) => {
    const existing = existingMap[email.toLowerCase()];
    const alreadyScannedThisAccount = existing?.accounts_seen?.includes(accountEmail);

    // If this account was already scanned, replace its contribution; otherwise add to existing
    const totalCount = alreadyScannedThisAccount
      ? data.count + Math.max(0, (existing?.reply_count || 0) - data.count) // approximate: keep the higher
      : data.count + (existing?.reply_count || 0);

    let tier: SenderTier = 'D';
    if (totalCount >= mins.A) tier = 'A';
    else if (totalCount >= mins.B) tier = 'B';
    else if (totalCount >= mins.C) tier = 'C';
    else if (totalCount >= mins.D) tier = 'D';

    const combinedAccounts = [...new Set([...(existing?.accounts_seen || []), accountEmail])];

    const item = {
      user_id: userId,
      sender_email: email,
      display_name: data.name,
      reply_count: totalCount,
      last_reply: data.lastDate ? new Date(data.lastDate).toISOString().split('T')[0] : null,
      tier,
      accounts_seen: combinedAccounts,
    };
    return encryptFields(item, [...ENCRYPTED_FIELDS.SENDER_PRIORITIES], userId);
  });

  if (upserts.length > 0) {
    for (let i = 0; i < upserts.length; i += 50) {
      const chunk = upserts.slice(i, i + 50);
      await admin.from(TABLES.SENDER_PRIORITIES).upsert(chunk, {
        onConflict: 'user_id,sender_email',
      });
    }
  }

  return {
    sendersFound: entries.length,
    totalReplies: entries.reduce((sum, [, d]) => sum + d.count, 0),
  };
}

// ============ FOLLOW-UP CACHE ============

interface FollowUpItem {
  message_id: string;
  thread_id: string;
  sender: string;
  sender_email: string;
  subject: string;
  snippet: string;
  date: string;
  account_email: string;
  type: 'starred' | 'awaiting';
}

/**
 * Pre-compute follow-up items for a user/account.
 * Finds starred sent messages and sent messages awaiting replies.
 * Stores results in the follow_up_cache table for instant loading.
 */
export async function computeFollowUps(
  client: gmail_v1.Gmail,
  userId: string,
  accountEmail: string
): Promise<{ starred: number; awaiting: number }> {
  const admin = createSupabaseAdmin();
  const items: FollowUpItem[] = [];

  // 1. Starred sent messages (user-flagged for follow-up)
  const starredRes = await gmail.listMessages(client, { query: 'in:sent is:starred', maxResults: 30 });
  if (starredRes.messages?.length) {
    const starredDetails = await Promise.all(
      starredRes.messages.map(m => gmail.getMessage(client, m.id!, 'metadata'))
    );
    for (const msg of starredDetails) {
      items.push({
        message_id: msg.id,
        thread_id: msg.threadId,
        sender: msg.sender,
        sender_email: msg.senderEmail,
        subject: msg.subject,
        snippet: msg.snippet,
        date: msg.date,
        account_email: accountEmail,
        type: 'starred',
      });
    }
  }

  // 2. Sent messages awaiting replies (sent in last 7 days, no reply after 24h)
  const sentRes = await gmail.listMessages(client, { query: 'in:sent newer_than:7d', maxResults: 20 });
  if (sentRes.messages?.length) {
    const sentDetails = await Promise.all(
      sentRes.messages.map(m => gmail.getMessage(client, m.id!, 'metadata'))
    );
    const candidates = sentDetails.filter(msg => {
      const hoursSince = (Date.now() - new Date(msg.date).getTime()) / (1000 * 60 * 60);
      return hoursSince >= 24 && !items.find(s => s.message_id === msg.id);
    });

    // Check threads in parallel for replies
    const results = await Promise.all(
      candidates.map(async (msg) => {
        try {
          const threadRes = await client.users.threads.get({
            userId: 'me', id: msg.threadId, format: 'metadata',
          });
          const sentDate = new Date(msg.date);
          for (const threadMsg of (threadRes.data.messages || [])) {
            const headers = threadMsg.payload?.headers || [];
            const from = (headers.find((h: any) => h.name?.toLowerCase() === 'from')?.value || '').toLowerCase();
            const msgDate = new Date(headers.find((h: any) => h.name?.toLowerCase() === 'date')?.value || 0);
            if (!from.includes(accountEmail.toLowerCase()) && msgDate > sentDate) return null; // Has reply
          }
          return msg; // No reply found
        } catch { return null; }
      })
    );

    for (const msg of results) {
      if (msg) {
        items.push({
          message_id: msg.id,
          thread_id: msg.threadId,
          sender: msg.sender,
          sender_email: msg.senderEmail,
          subject: msg.subject,
          snippet: msg.snippet,
          date: msg.date,
          account_email: accountEmail,
          type: 'awaiting',
        });
      }
    }
  }

  // Encrypt and store in cache (replace existing cache for this user+account)
  const encrypted = encryptJson(items, userId);
  await admin.from(TABLES.FOLLOW_UP_CACHE).upsert(
    {
      user_id: userId,
      account_email: accountEmail,
      data: encrypted,
      computed_at: new Date().toISOString(),
      starred_count: items.filter(i => i.type === 'starred').length,
      awaiting_count: items.filter(i => i.type === 'awaiting').length,
    },
    { onConflict: 'user_id,account_email' }
  );

  return {
    starred: items.filter(i => i.type === 'starred').length,
    awaiting: items.filter(i => i.type === 'awaiting').length,
  };
}
