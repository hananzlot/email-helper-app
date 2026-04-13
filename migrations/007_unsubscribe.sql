-- Auto-unsubscribe tracking
CREATE TABLE IF NOT EXISTS "emailHelperV2_unsubscribe_log" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  sender_email TEXT NOT NULL,
  domain TEXT NOT NULL,
  method TEXT NOT NULL, -- 'header_mailto', 'header_url', 'body_link', 'manual', 'failed'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'success', 'failed'
  unsubscribe_url TEXT,
  error_message TEXT,
  message_id TEXT, -- the Gmail message ID used to extract the link
  account_email TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_user
  ON "emailHelperV2_unsubscribe_log" (user_id, domain);

ALTER TABLE "emailHelperV2_unsubscribe_log" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only see their own unsubscribe log"
  ON "emailHelperV2_unsubscribe_log"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
