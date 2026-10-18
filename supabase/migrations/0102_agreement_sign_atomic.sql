-- 0102_agreement_sign_atomic.sql (2026-10-18, Codex rev4 review items 2 and 4)
--
--   * agreement_sign(): the owner's agreement to a store's policies is recorded in ONE transaction against the policy
--     text the owner actually saw. The caller passes the hash shown to them (agreement-check's policy_hash); the function
--     locks the retailer row FOR SHARE, serialises signers of the same brand+store with an advisory lock, recomputes the
--     current hash with agreement_policy_hash() (0098) and refuses a stale hash (outcome policy_changed) without writing.
--     A live agreement with the same hash is returned as already_current (a lost response or a concurrent second signer
--     makes no second row). Otherwise the prior row is superseded and the replacement inserted and linked in the same
--     transaction, so a failure anywhere leaves the still-valid prior agreement untouched.
--   * brand_members.terms_digest and booker_accept(p_terms_digest): the booker's Terms acceptance carries a digest of the
--     terms text alongside the version, so the record names the content accepted. The 0101 overload is dropped.
--
-- No begin/commit here: the production paste wraps 0097 + 0098 + 0100 + 0101 + 0102 in one transaction.

CREATE OR REPLACE FUNCTION agreement_sign(
  p_brand_id uuid, p_retailer_id uuid, p_signed_email text, p_signed_name text, p_signed_ip text, p_user_agent text,
  p_expected_hash text, p_default_demo text, p_default_cancel text, p_tos_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r retailers%ROWTYPE; v_hash text; v_prior brand_retailer_agreements%ROWTYPE; v_new_id uuid; v_demo text; v_cancel text;
BEGIN
  IF p_brand_id IS NULL OR p_retailer_id IS NULL THEN RAISE EXCEPTION 'agreement_sign: brand and retailer required' USING errcode = 'check_violation'; END IF;
  IF coalesce(btrim(p_signed_name), '') = '' OR length(btrim(p_signed_name)) < 2 THEN RETURN jsonb_build_object('outcome', 'signed_name_required'); END IF;
  IF coalesce(btrim(p_expected_hash), '') = '' THEN RETURN jsonb_build_object('outcome', 'policy_hash_required'); END IF;
  -- one signer at a time per brand+store; the store's text held stable while we compare and write
  PERFORM pg_advisory_xact_lock(hashtext('agreement_sign:' || p_brand_id::text || ':' || p_retailer_id::text));
  SELECT * INTO v_r FROM retailers WHERE id = p_retailer_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'retailer_not_found'); END IF;
  v_hash := agreement_policy_hash(v_r.demo_policy, v_r.cancellation_policy, p_default_demo, p_default_cancel, p_tos_version);
  IF lower(btrim(p_expected_hash)) <> v_hash THEN
    RETURN jsonb_build_object('outcome', 'policy_changed', 'current_hash', v_hash);
  END IF;
  SELECT * INTO v_prior FROM brand_retailer_agreements
   WHERE brand_id = p_brand_id AND retailer_id = p_retailer_id AND superseded_at IS NULL
   ORDER BY signed_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND v_prior.policy_hash = v_hash AND v_prior.expires_at > now() THEN
    RETURN jsonb_build_object('outcome', 'already_current', 'agreement_id', v_prior.id, 'policy_hash', v_hash, 'signed_at', v_prior.signed_at);
  END IF;
  v_demo := coalesce(nullif(v_r.demo_policy, ''), p_default_demo);
  v_cancel := coalesce(nullif(v_r.cancellation_policy, ''), p_default_cancel);
  IF FOUND THEN
    UPDATE brand_retailer_agreements SET superseded_at = now() WHERE id = v_prior.id;   -- the partial unique index allows one live row
  END IF;
  INSERT INTO brand_retailer_agreements (brand_id, retailer_id, signed_name, signed_email, signed_ip, signed_user_agent, demo_policy_snapshot, cancellation_policy_snapshot, policy_hash)
  VALUES (p_brand_id, p_retailer_id, left(btrim(p_signed_name), 200), lower(coalesce(p_signed_email, '')), p_signed_ip, p_user_agent, v_demo, v_cancel, v_hash)
  RETURNING id INTO v_new_id;
  IF v_prior.id IS NOT NULL THEN
    UPDATE brand_retailer_agreements SET superseded_by = v_new_id WHERE id = v_prior.id;
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'agreement_id', v_new_id, 'policy_hash', v_hash, 'superseded', v_prior.id);
END $$;
REVOKE ALL ON FUNCTION agreement_sign(uuid, uuid, text, text, text, text, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION agreement_sign(uuid, uuid, text, text, text, text, text, text, text, text) TO service_role;

ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS terms_digest text;

DROP FUNCTION IF EXISTS booker_accept(text, text, text, text, integer, integer);

CREATE FUNCTION booker_accept(p_token_hash text, p_code_hash text, p_session_token text, p_terms_version text, p_terms_digest text DEFAULT NULL, p_session_days integer DEFAULT 30, p_max_attempts integer DEFAULT 6)
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
  UPDATE brand_members SET status = 'accepted', accepted_at = now(), terms_accepted_at = now(), terms_version = btrim(p_terms_version), terms_digest = nullif(btrim(coalesce(p_terms_digest, '')), '') WHERE id = v_m.id;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (v_m.brand_id, p_session_token, lower(v_m.email), v_exp);
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'expires_at', v_exp, 'terms_version', btrim(p_terms_version));
END $$;
REVOKE ALL ON FUNCTION booker_accept(text, text, text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_accept(text, text, text, text, text, integer, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'agreement_sign';
  IF n <> 1 THEN RAISE EXCEPTION '0102 postcondition: agreement_sign must have exactly one overload, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booker_accept';
  IF n <> 1 THEN RAISE EXCEPTION '0102 postcondition: booker_accept must have exactly one overload, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = 'booker_accept' AND pg_get_function_identity_arguments(p.oid) = 'p_token_hash text, p_code_hash text, p_session_token text, p_terms_version text, p_terms_digest text, p_session_days integer, p_max_attempts integer';
  IF n <> 1 THEN RAISE EXCEPTION '0102 postcondition: booker_accept does not carry p_terms_digest'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'brand_members' AND column_name = 'terms_digest';
  IF n <> 1 THEN RAISE EXCEPTION '0102 postcondition: brand_members.terms_digest missing'; END IF;
  IF to_regclass('public.brand_retailer_agreements') IS NULL THEN RAISE EXCEPTION '0102 postcondition: brand_retailer_agreements missing'; END IF;
END $$;
