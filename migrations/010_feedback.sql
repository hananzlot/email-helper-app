-- User feedback, feature requests, and bug reports
CREATE TABLE IF NOT EXISTS "emailHelperV2_feedback" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  user_email TEXT NOT NULL,
  type TEXT NOT NULL, -- 'bug', 'feature', 'feedback'
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', -- 'new', 'reviewed', 'resolved'
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feedback_status
  ON "emailHelperV2_feedback" (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_user
  ON "emailHelperV2_feedback" (user_id, created_at DESC);

ALTER TABLE "emailHelperV2_feedback" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only see their own feedback"
  ON "emailHelperV2_feedback"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
