-- Cross-Account Protection (Google RISC) support.
-- Lets us react to security events from Google: sessions revoked, tokens revoked,
-- account disabled / purged / credential change required. When we receive an event,
-- we delete the user's stored Gmail tokens and invalidate their server-side sessions.

-- Stable Google subject ID (the OpenID `sub` claim). Required because RISC events
-- identify the user via iss_sub, not by email — emails can change, sub is permanent.
ALTER TABLE "emailHelperV2_gmail_accounts"
  ADD COLUMN IF NOT EXISTS google_sub TEXT;

CREATE INDEX IF NOT EXISTS idx_gmail_accounts_google_sub
  ON "emailHelperV2_gmail_accounts" (google_sub);

-- Replay protection for incoming Security Event Tokens.
-- Google may resend the same event; we record each jti and ignore duplicates.
CREATE TABLE IF NOT EXISTS "emailHelperV2_risc_processed_jtis" (
  jti TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_email TEXT,
  subject_sub TEXT,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_risc_jtis_expires
  ON "emailHelperV2_risc_processed_jtis" (expires_at);

-- Periodic cleanup of old jti records (anything older than 30 days can be safely forgotten,
-- since Google's RISC service won't replay events that old).
CREATE OR REPLACE FUNCTION cleanup_expired_risc_jtis()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "emailHelperV2_risc_processed_jtis"
  WHERE expires_at < NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_expired_risc_jtis
  AFTER INSERT ON "emailHelperV2_risc_processed_jtis"
  FOR EACH STATEMENT
  EXECUTE FUNCTION cleanup_expired_risc_jtis();
