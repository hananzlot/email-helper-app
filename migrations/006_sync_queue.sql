-- Sync queue: instead of every client running its own sync loop,
-- clients submit requests and a central processor handles them sequentially.
-- This prevents Gmail quota issues with multiple simultaneous users.

CREATE TABLE IF NOT EXISTS "emailHelperV2_sync_queue" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  account_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, done, error
  priority INTEGER DEFAULT 5, -- 1=highest, 10=lowest
  pages_processed INTEGER DEFAULT 0,
  messages_cached INTEGER DEFAULT 0,
  total_inbox INTEGER DEFAULT 0,
  error_message TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, account_email, status) -- only one pending/processing job per account
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_status
  ON "emailHelperV2_sync_queue" (status, priority, requested_at);

ALTER TABLE "emailHelperV2_sync_queue" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only see their own sync jobs"
  ON "emailHelperV2_sync_queue"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
