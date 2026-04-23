-- PKCE support for OAuth flow.
-- Stores the PKCE code_verifier server-side so the callback can exchange the
-- authorization code with proof that it owns the original /authorize request.
-- Closes the "auth code interception" attack class even if `state` is bypassed.
ALTER TABLE "emailHelperV2_oauth_states"
  ADD COLUMN IF NOT EXISTS code_verifier TEXT;
