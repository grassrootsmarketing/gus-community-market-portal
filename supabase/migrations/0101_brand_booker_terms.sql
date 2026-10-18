-- 0101_brand_booker_terms.sql (2026-10-18)
-- The designated booker accepts Demohub's Terms of Service when accepting the invitation (David, after the October 17
-- preview run: the booker agreed to nothing in their own name; store policies stay the owner's to agree to).
--
--   * brand_members.terms_accepted_at / terms_version: recorded in the same transaction that accepts the membership.
--   * booker_accept gains p_terms_version (required: an empty value is refused as terms_required) and records both
--     columns; the previous overload is dropped so exactly one remains.
--
-- No begin/commit here: the production paste wraps 0097 + 0098 + 0100 + 0101 in one transaction.

ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS terms_version text;

DROP FUNCTION IF EXISTS booker_accept(text, text, text, integer, integer);

CREATE FUNCTION booker_accept(p_token_hash text, p_code_hash text, p_session_token text, p_terms_version text, p_session_days integer DEFAULT 30, p_max_attempts integer DEFAULT 6)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i brand_booker_invites%ROWTYPE; v_m brand_members%ROWTYPE; v_exp timestamptz;
BEGIN
  IF coalesce(p_token_hash, '') = '' OR coalesce(p_code_hash, '') = '' OR coalesce(p_session_token, '') = '' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF coalesce(btrim(p_terms_version), '') = '' THEN RETURN jsonb_build_object('outcome', 'terms_required'); END IF;
  SELECT member_id INTO v_i.member_id FROM brand_booker_invites WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE id = v_i.member_id FOR UPDATE;                       -- membership first
  SELECT * INTO v_i FROM brand_booker_invites WHERE token_hash = p_token_hash FOR UPDATE;          -- then the invitation
  IF v_i.used_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'already_used'); END IF;
  IF v_i.superseded_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'superseded'); END IF;
  IF v_i.expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'expired'); END IF;
  IF v_m.role <> 'booker' OR v_m.brand_id <> v_i.brand_id OR lower(v_m.email) <> lower(v_i.email) THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'revoked'); END IF;
  IF v_m.status = 'accepted' THEN RETURN jsonb_build_object('outcome', 'already_accepted'); END IF;
  IF v_i.code_hash IS NULL OR v_i.code_expires_at IS NULL OR v_i.code_expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'code_expired'); END IF;
  IF v_i.code_attempts >= p_max_attempts THEN
    UPDATE brand_booker_invites SET superseded_at = now() WHERE id = v_i.id;
    RETURN jsonb_build_object('outcome', 'too_many_attempts');
  END IF;
  IF v_i.code_hash <> p_code_hash THEN
    UPDATE brand_booker_invites SET code_attempts = code_attempts + 1 WHERE id = v_i.id;
    IF v_i.code_attempts + 1 >= p_max_attempts THEN UPDATE brand_booker_invites SET superseded_at = now() WHERE id = v_i.id; RETURN jsonb_build_object('outcome', 'too_many_attempts'); END IF;
    RETURN jsonb_build_object('outcome', 'invalid_code', 'attempts_left', p_max_attempts - (v_i.code_attempts + 1));
  END IF;
  UPDATE brand_booker_invites SET used_at = now() WHERE id = v_i.id;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND id <> v_i.id AND used_at IS NULL AND superseded_at IS NULL;
  UPDATE brand_members SET status = 'accepted', accepted_at = now(), terms_accepted_at = now(), terms_version = btrim(p_terms_version) WHERE id = v_m.id;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (v_m.brand_id, p_session_token, lower(v_m.email), v_exp);
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'expires_at', v_exp, 'terms_version', btrim(p_terms_version));
END $$;
REVOKE ALL ON FUNCTION booker_accept(text, text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_accept(text, text, text, text, integer, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name IN ('terms_accepted_at','terms_version');
  IF n <> 2 THEN RAISE EXCEPTION '0101 postcondition: terms columns missing (%/2)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booker_accept';
  IF n <> 1 THEN RAISE EXCEPTION '0101 postcondition: booker_accept must have exactly one overload, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = 'booker_accept' AND pg_get_function_identity_arguments(p.oid) = 'p_token_hash text, p_code_hash text, p_session_token text, p_terms_version text, p_session_days integer, p_max_attempts integer';
  IF n <> 1 THEN RAISE EXCEPTION '0101 postcondition: booker_accept does not carry p_terms_version'; END IF;
END $$;
