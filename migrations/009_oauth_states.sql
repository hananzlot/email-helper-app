-- Server-side OAuth state nonce storage (replaces cookie-based nonce)
-- Prevents CSRF and state forgery on OAuth callback
CREATE TABLE IF NOT EXISTS "emailHelperV2_oauth_states" (
  nonce_hash TEXT PRIMARY KEY,           -- HMAC-SHA256 hash of the nonce
  flow TEXT NOT NULL DEFAULT 'login',    -- 'login' or 'add_account'
  user_id UUID,                          -- only set for add_account flow
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-cleanup expired states on every insert
CREATE OR REPLACE FUNCTION cleanup_expired_oauth_states()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "emailHelperV2_oauth_states"
  WHERE expires_at < NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_expired_oauth_states
  AFTER INSERT ON "emailHelperV2_oauth_states"
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_expired_oauth_states();
