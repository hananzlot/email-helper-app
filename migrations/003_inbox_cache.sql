-- Inbox message cache: one row per message for instant load on return visits
CREATE TABLE IF NOT EXISTS "emailHelperV2_inbox_cache" (
  user_id       UUID NOT NULL,
  account_email TEXT NOT NULL,
  gmail_id      TEXT NOT NULL,
  thread_id     TEXT,
  sender        TEXT NOT NULL DEFAULT '',
  sender_email  TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  snippet       TEXT DEFAULT '',
  date          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_unread     BOOLEAN DEFAULT TRUE,
  label_ids     TEXT[] DEFAULT '{}',
  cached_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, account_email, gmail_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_cache_date
  ON "emailHelperV2_inbox_cache" (user_id, account_email, date DESC);

-- Sync state tracker per account
CREATE TABLE IF NOT EXISTS "emailHelperV2_inbox_sync" (
  user_id        UUID NOT NULL,
  account_email  TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ,
  total_cached   INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, account_email)
);
