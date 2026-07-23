-- Adds a 6-digit numeric login code alongside the token URL for magic-link auth.
-- Existing token URL flow keeps working — codes are additive.
--
-- Run this in Supabase SQL editor.

ALTER TABLE admin_tokens
    ADD COLUMN IF NOT EXISTS code TEXT;

-- Index for fast code lookup during verify-code action.
-- Partial index because we only care about unused, unexpired codes.
CREATE INDEX IF NOT EXISTS admin_tokens_code_lookup
    ON admin_tokens (code, email)
    WHERE code IS NOT NULL AND used_at IS NULL;

COMMENT ON COLUMN admin_tokens.code IS '6-digit numeric login code for code-based magic-link auth. Alternative to using the token URL directly.';
