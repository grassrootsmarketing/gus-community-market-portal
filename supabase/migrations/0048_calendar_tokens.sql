-- 0048_calendar_tokens.sql — WO-4 / Codex P0-7: dedicated, revocable calendar feed tokens.
--
-- The .ics feed currently authenticates with brand_account_sessions.session_token — the actual
-- LOGIN token. A calendar URL is meant to be pasted into Google/Apple Calendar and is frequently
-- shared with colleagues, so that design hands out a working session credential: anyone holding the
-- URL can act as the brand. Calendar subscription URLs are also fetched by third-party servers and
-- can end up in logs.
--
-- Fix: a separate token type that is read-only by construction (it can ONLY be used by the feed),
-- independently revocable, and rotatable without logging the brand out.
BEGIN;

CREATE TABLE IF NOT EXISTS brand_calendar_tokens (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS brand_calendar_tokens_brand_idx ON brand_calendar_tokens(brand_id) WHERE revoked_at IS NULL;
ALTER TABLE brand_calendar_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brand_calendar_tokens FROM anon, authenticated;

-- Resolve a calendar token to its brand. Returns NULL for unknown/revoked tokens. Stamps last_used
-- so an operator can spot a URL still being polled after it should have been retired.
CREATE OR REPLACE FUNCTION resolve_calendar_token(p_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_brand uuid;
BEGIN
  SELECT brand_id INTO v_brand FROM brand_calendar_tokens
   WHERE token = p_token AND revoked_at IS NULL;
  IF v_brand IS NULL THEN RETURN NULL; END IF;
  UPDATE brand_calendar_tokens SET last_used_at = now() WHERE token = p_token;
  RETURN v_brand;
END $$;

-- Mint (or rotate) the brand's calendar token. Rotating revokes every previous token, which is what
-- "my calendar link leaked" needs to do — without touching login sessions.
CREATE OR REPLACE FUNCTION issue_calendar_token(p_brand_id uuid, p_rotate boolean DEFAULT false, p_label text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid;
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_required'; END IF;
  IF coalesce(p_rotate,false) THEN
    UPDATE brand_calendar_tokens SET revoked_at = now() WHERE brand_id = p_brand_id AND revoked_at IS NULL;
  ELSE
    SELECT token INTO v_token FROM brand_calendar_tokens
     WHERE brand_id = p_brand_id AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1;
    IF v_token IS NOT NULL THEN RETURN v_token; END IF;
  END IF;
  INSERT INTO brand_calendar_tokens(brand_id, label) VALUES (p_brand_id, p_label) RETURNING token INTO v_token;
  RETURN v_token;
END $$;

CREATE OR REPLACE FUNCTION revoke_calendar_tokens(p_brand_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE brand_calendar_tokens SET revoked_at = now() WHERE brand_id = p_brand_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

REVOKE ALL ON FUNCTION resolve_calendar_token(uuid)                     FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION issue_calendar_token(uuid,boolean,text)          FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION revoke_calendar_tokens(uuid)                     FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_calendar_token(uuid)                   TO service_role;
GRANT EXECUTE ON FUNCTION issue_calendar_token(uuid,boolean,text)        TO service_role;
GRANT EXECUTE ON FUNCTION revoke_calendar_tokens(uuid)                   TO service_role;

COMMIT;
