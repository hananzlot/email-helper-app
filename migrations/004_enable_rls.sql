-- Enable RLS on action_history, inbox_cache, inbox_sync
-- Safe: our API uses service_role key which bypasses RLS
-- This protects against direct access via anon key

-- Action History
ALTER TABLE "emailHelperV2_action_history" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own action history"
  ON "emailHelperV2_action_history"
  FOR ALL
  USING (user_id = auth.uid()::text)
  WITH CHECK (user_id = auth.uid()::text);

-- Inbox Cache
ALTER TABLE "emailHelperV2_inbox_cache" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own inbox cache"
  ON "emailHelperV2_inbox_cache"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Inbox Sync
ALTER TABLE "emailHelperV2_inbox_sync" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own inbox sync"
  ON "emailHelperV2_inbox_sync"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
