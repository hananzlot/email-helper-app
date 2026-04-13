-- Server-side session tokens for secure authentication
-- Cookie contains HMAC-signed token; DB stores SHA-256 hash of token
CREATE TABLE IF NOT EXISTS "emailHelperV2_sessions" (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,         -- SHA-256 hash of the session token
  user_id UUID NOT NULL,
  account_email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup by token hash (primary auth path)
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON "emailHelperV2_sessions" (token_hash);

-- Cleanup expired sessions, invalidate all for a user
CREATE INDEX IF NOT EXISTS idx_sessions_user_id
  ON "emailHelperV2_sessions" (user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON "emailHelperV2_sessions" (expires_at);

-- RLS: sessions are managed server-side via service role key,
-- but add RLS for defense-in-depth
ALTER TABLE "emailHelperV2_sessions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only see their own sessions"
  ON "emailHelperV2_sessions"
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Auto-cleanup expired sessions (runs on every insert)
CREATE OR REPLACE FUNCTION cleanup_expired_sessions()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "emailHelperV2_sessions"
  WHERE expires_at < NOW() - INTERVAL '1 day';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_expired_sessions
  AFTER INSERT ON "emailHelperV2_sessions"
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_expired_sessions();
