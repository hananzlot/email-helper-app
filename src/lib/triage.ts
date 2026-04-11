import { gmail_v1 } from 'googleapis';
import * as gmail from './gmail';
import { createSupabaseAdmin } from './supabase-server';
import { TABLES } from './tables';
import type { GmailMessage, TriagedEmail, TriageResult, Priority, SenderTier } from '@/types';

// ============ TRIAGE ENGINE ============

interface SenderData {
  sender_email: string;
  display_name: string;
  reply_count: number;
  tier: SenderTier;
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
      .select('sender_email, display_name, reply_count, tier')
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
    senders[s.sender_email.toLowerCase()] = s;
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

  // Store in Supabase (upsert by user + account)
  await admin.from(TABLES.TRIAGE_RESULTS).upsert(
    {
      user_id: userId,
      account_email: accountEmail,
      triaged_at: result.triaged_at,
      total_unread: result.total_unread,
      data: result,
    },
    { onConflict: 'user_id,account_email' }
  );

  // Populate reply queue with ALL scored emails (so user sees full picture)
  if (triaged.length > 0) {
    const queueItems = triaged.map((e) => ({
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
    }));

    // Batch upsert in chunks of 25 to avoid payload limits
    for (let i = 0; i < queueItems.length; i += 25) {
      const chunk = queueItems.slice(i, i + 25);
      await admin.from(TABLES.REPLY_QUEUE).upsert(chunk, {
        onConflict: 'user_id,message_id',
        ignoreDuplicates: true,
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

export async function scanSentMail(
  client: gmail_v1.Gmail,
  userId: string,
  accountEmail: string
): Promise<{ sendersFound: number; totalReplies: number }> {
  const admin = createSupabaseAdmin();
  const senderCounts: Record<string, { name: string; count: number; lastDate: string }> = {};

  let pageToken: string | undefined;
  let totalScanned = 0;

  // Scan up to 500 sent messages (about 1-2 years of activity for most people)
  while (totalScanned < 500) {
    const batch = await gmail.listMessages(client, {
      query: 'in:sent',
      maxResults: 50,
      pageToken,
    });

    if (!batch.messages || batch.messages.length === 0) break;

    const details = await Promise.all(
      batch.messages.map((m) => gmail.getMessage(client, m.id!, 'metadata'))
    );

    for (const msg of details) {
      // Extract the "To" address from the sent message
      const toEmail = msg.senderEmail; // For sent messages, this is actually "From" (you)
      // We need the To header — let's get it differently
      // Actually, getMessage returns the From header. For sent mail,
      // we need to look at the recipients. Let's use the snippet as a signal
      // and re-fetch with the To header.
    }

    // For sent mail, we need to extract recipients
    const fullDetails = await Promise.all(
      batch.messages.map((m) => gmail.getMessage(client, m.id!, 'full'))
    );

    for (const msg of fullDetails) {
      // The "sender" field in our GmailMessage is From: (which is you for sent mail)
      // We need to parse the To: header from the raw message
      // Actually, getMessage already parses headers — but our type only has "sender" (From)
      // Let's extract To from the body/snippet or use a different approach

      // For sent messages, look at who you're sending TO
      // We'll use a regex on the body to find email addresses
      // Better: get the raw message headers
    }

    totalScanned += batch.messages.length;
    pageToken = batch.nextPageToken || undefined;
    if (!batch.nextPageToken) break;
  }

  // For now, use a simpler approach: search for replies
  // "in:sent" messages where the subject starts with "Re:" indicate replies
  const replyCounts: Record<string, { name: string; count: number; lastDate: string }> = {};
  let replyPageToken: string | undefined;
  let repliesScanned = 0;

  while (repliesScanned < 500) {
    const batch = await gmail.listMessages(client, {
      query: 'in:sent subject:Re:',
      maxResults: 50,
      pageToken: replyPageToken,
    });

    if (!batch.messages || batch.messages.length === 0) break;

    // Get thread info to find who we replied to
    for (const msg of batch.messages) {
      try {
        const thread = await gmail.getThread(client, msg.threadId!);
        const messages = thread.messages || [];

        // Find the first message in the thread that's not from us
        for (const threadMsg of messages) {
          const headers = threadMsg.payload?.headers || [];
          const from = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
          const fromName = from.match(/^(.+?)\s*</)?.[1]?.replace(/"/g, '').trim() || fromEmail;

          // Skip our own messages
          if (fromEmail.toLowerCase() === accountEmail.toLowerCase()) continue;

          const key = fromEmail.toLowerCase();
          if (!replyCounts[key]) {
            replyCounts[key] = { name: fromName, count: 0, lastDate: '' };
          }
          replyCounts[key].count++;

          const date = headers.find(h => h.name?.toLowerCase() === 'date')?.value || '';
          if (date > replyCounts[key].lastDate) {
            replyCounts[key].lastDate = date;
          }
          break; // Only count the first non-self message in the thread
        }
      } catch {
        // Skip threads that fail
      }
    }

    repliesScanned += batch.messages.length;
    replyPageToken = batch.nextPageToken || undefined;
    if (!batch.nextPageToken) break;
  }

  // Calculate tiers based on reply counts
  const entries = Object.entries(replyCounts);
  entries.sort((a, b) => b[1].count - a[1].count);
  const total = entries.length;

  const tierThresholds = {
    A: Math.ceil(total * 0.1),   // Top 10%
    B: Math.ceil(total * 0.3),   // Next 20%
    C: Math.ceil(total * 0.6),   // Next 30%
  };

  // Upsert sender priorities
  const upserts = entries.map(([email, data], idx) => {
    let tier: SenderTier = 'D';
    if (idx < tierThresholds.A) tier = 'A';
    else if (idx < tierThresholds.B) tier = 'B';
    else if (idx < tierThresholds.C) tier = 'C';

    return {
      user_id: userId,
      sender_email: email,
      display_name: data.name,
      reply_count: data.count,
      last_reply: data.lastDate ? new Date(data.lastDate).toISOString().split('T')[0] : null,
      tier,
      accounts_seen: [accountEmail],
    };
  });

  if (upserts.length > 0) {
    // Batch upsert in chunks of 50
    for (let i = 0; i < upserts.length; i += 50) {
      const chunk = upserts.slice(i, i + 50);
      await admin.from(TABLES.SENDER_PRIORITIES).upsert(chunk, {
        onConflict: 'user_id,sender_email',
      });
    }
  }

  // Update gmail_accounts with senders found count
  await admin
    .from(TABLES.GMAIL_ACCOUNTS)
    .update({ senders_found: entries.length, status: 'scanned' })
    .eq('user_id', userId)
    .eq('email', accountEmail);

  return {
    sendersFound: entries.length,
    totalReplies: entries.reduce((sum, [, d]) => sum + d.count, 0),
  };
}
