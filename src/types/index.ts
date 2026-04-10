// ============ USER & AUTH ============

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  primary_account: string | null;
  active_inboxes: string[];
  created_at: string;
}

export interface GmailAccount {
  id: string;
  user_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
  is_primary: boolean;
  is_active_inbox: boolean;
  senders_found: number;
  status: 'connected' | 'scanned' | 'disconnected';
  created_at: string;
}

// ============ GMAIL ============

export interface GmailMessage {
  id: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  snippet: string;
  body?: string;
  date: string;
  labelIds: string[];
  isUnread: boolean;
}

export interface GmailDraft {
  id: string;
  messageId: string;
  to: string;
  subject: string;
  body: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  messagesUnread: number;
}

// ============ TRIAGE ============

export type Priority = 'urgent' | 'important' | 'normal' | 'low';
export type SenderTier = 'A' | 'B' | 'C' | 'D';

export interface TriagedEmail {
  id: string;
  threadId: string;
  sender: string;
  senderEmail: string;
  subject: string;
  summary: string;
  tier: SenderTier | 'N/A';
  priority: Priority;
  priorityScore: number; // 0-10
  received: string;
  gmailUrl: string;
  draftUrl?: string;
  status: 'active' | 'done' | 'snoozed' | 'later';
  account: string;
}

export interface TriageResult {
  account: string;
  triaged_at: string;
  total_unread: number;
  categories: {
    reply_needed: TriagedEmail[];
    important_notifications: TriagedEmail[];
    worth_reading: TriagedEmail[];
    low_priority: TriagedEmail[];
  };
}

// ============ SENDER PRIORITIES ============

export interface SenderPriority {
  sender_email: string;
  display_name: string;
  reply_count: number;
  last_reply: string;
  tier: SenderTier;
  accounts_seen: string[];
}

// ============ NOTIFICATION RULES ============

export interface NotificationRule {
  id: string;
  user_id: string;
  pattern: string;
  category: string;
  description: string;
  default_priority: number;
  user_priority: number | null;
}

// ============ API RESPONSES ============

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============ GMAIL API ACTIONS ============

export type GmailAction =
  | { type: 'archive'; messageIds: string[] }
  | { type: 'trash'; messageIds: string[] }
  | { type: 'delete'; messageIds: string[] }
  | { type: 'markRead'; messageIds: string[] }
  | { type: 'markUnread'; messageIds: string[] }
  | { type: 'star'; messageIds: string[] }
  | { type: 'unstar'; messageIds: string[] }
  | { type: 'addLabel'; messageIds: string[]; labelId: string }
  | { type: 'removeLabel'; messageIds: string[]; labelId: string };
