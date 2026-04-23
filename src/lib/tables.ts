/**
 * Central table name constants.
 * All Clearbox tables are prefixed with emailHelperV2_ to coexist
 * with other data in the same Supabase project.
 */
export const TABLES = {
  USER_PROFILES: 'emailHelperV2_user_profiles',
  GMAIL_ACCOUNTS: 'emailHelperV2_gmail_accounts',
  SENDER_PRIORITIES: 'emailHelperV2_sender_priorities',
  NOTIFICATION_RULES: 'emailHelperV2_notification_rules',
  TRIAGE_RESULTS: 'emailHelperV2_triage_results',
  REPLY_QUEUE: 'emailHelperV2_reply_queue',
  CLEANUP_REPORTS: 'emailHelperV2_cleanup_reports',
  FOLLOW_UP_CACHE: 'emailHelperV2_follow_up_cache',
  ACTION_HISTORY: 'emailHelperV2_action_history',
  INBOX_CACHE: 'emailHelperV2_inbox_cache',
  INBOX_SYNC: 'emailHelperV2_inbox_sync',
  SYNC_QUEUE: 'emailHelperV2_sync_queue',
  UNSUBSCRIBE_LOG: 'emailHelperV2_unsubscribe_log',
  SESSIONS: 'emailHelperV2_sessions',
  BACKUP_JOBS: 'emailHelperV2_backup_jobs',
  FEEDBACK: 'emailHelperV2_feedback',
  RISC_PROCESSED_JTIS: 'emailHelperV2_risc_processed_jtis',
} as const;
