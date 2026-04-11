-- Action history table for Clearbox
-- Stores encrypted action metadata for 7-day history with undo support
CREATE TABLE IF NOT EXISTS "emailHelperV2_action_history" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- raw action type (archive, trash, markRead, etc.)
  action_label TEXT NOT NULL,      -- encrypted display label
  message_ids TEXT[] DEFAULT '{}', -- Gmail message IDs affected
  account_email TEXT NOT NULL,     -- encrypted account email
  subjects TEXT NOT NULL,          -- encrypted JSON array of email subjects
  undo_action TEXT,                -- reverse action type (nullable if not undoable)
  undone BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by user + time range (descending for newest-first)
CREATE INDEX IF NOT EXISTS idx_action_history_user_time
  ON "emailHelperV2_action_history" (user_id, created_at DESC);

-- Auto-cleanup: delete entries older than 7 days (run via cron or Supabase scheduled function)
-- For now, the API filters by date on read.
