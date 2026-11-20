-- 0121_multi_brand_access.sql (2026-11-19)
-- ============================================================================
-- One person, many brands (David, 2026-11-19). A demo agency rep books for ten or more brands with one email.
-- Until now one email was one identity across all brands (0097 BK-1), so a rep who owned one brand account could
-- not be given access to another and ended up putting a second brand's products under the first.
--
-- The new rule: an email may OWN at most one brand AND hold accepted access to any number of other brands.
--
--   * brand_members.role gains 'manager' ("Full access": everything the owner can do except managing who has access
--     and the owner sign-in itself). 'booker' stays "Booking only". 'owner' is unchanged.
--   * The one-identity index and the one-booker-per-brand index are dropped. The old rule is still enforced, under the
--     brand row lock, by brand_access_grant(p_multi => false), which the API calls while MULTI_BRAND_ACCESS_ENABLED is
--     not exactly "true". So the release ships dark and rolls back by unsetting the switch.
--   * A new index keeps "one owned brand per email".
--   * Hijack protection (0064, 0097 BK-3) is kept: an invitation is inert until the invited person accepts it, a
--     request is inert until the brand's owner approves it, and sign-in always lands an owner in their OWN brand.
--     Changing the active brand is a session action (brand_session_switch): the session's own email must own the
--     target brand or hold ACCEPTED access to it, and the session token is rotated.
--   * brand_access_requests: a signed-in rep asks for access to a brand by the owner's email. The owner approves from
--     the email with a token that is stored hashed, bound to the request AND to the owner email the brand had when it
--     was asked, single use, expiring. Approval creates the accepted membership in the same transaction.
--   * redeem_brand_signup keeps its signature. Resolution: own brand, else the most recently used accepted access,
--     else a pending invitation (never accepted by signing in), else a new brand.
--
-- Forward-only. No row rewrites. No begin/commit here: applied in one transaction with its ledger row.
-- ============================================================================

DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.brand_booker_invites') IS NULL OR to_regprocedure('booker_accept(text,text,text,text,text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION '0121 precondition: the booker objects of 0097 to 0102 are missing.';
  END IF;
  SELECT count(*) INTO n FROM (SELECT lower(email) FROM brand_members WHERE role = 'owner' GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION '0121 precondition: % email(s) own more than one brand. Review before applying.', n; END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Roles, the "last used" marker, and the indexes.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE brand_members DROP CONSTRAINT IF EXISTS brand_members_role_check;
ALTER TABLE brand_members ADD CONSTRAINT brand_members_role_check CHECK (role IN ('owner','booker','manager'));
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_payer_role_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_payer_role_check CHECK (payer_role IS NULL OR payer_role IN ('owner','booker','manager'));

DROP INDEX IF EXISTS brand_members_one_identity_idx;
DROP INDEX IF EXISTS brand_members_one_booker_idx;
CREATE UNIQUE INDEX IF NOT EXISTS brand_members_one_owned_brand_idx ON brand_members (lower(email)) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS brand_members_live_email_idx ON brand_members (lower(email)) WHERE status IN ('pending','accepted');

-- The insert trigger keeps the owner defaults and the lower-cased email. The "this email owns a brand" refusal moves
-- into brand_access_grant, where it applies only while the multi-brand switch is off.
CREATE OR REPLACE FUNCTION brand_members_owner_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.role = 'owner' THEN
    NEW.status := 'accepted';
    IF NEW.accepted_at IS NULL THEN NEW.accepted_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Granting access (owner action). One transaction under the brand row lock, so two grants serialize.
--    p_multi = false is the 0097 rule set: booking only, one live person per brand, one identity per email.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brand_access_grant(p_brand_id uuid, p_email text, p_name text, p_role text, p_by_email text, p_multi boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b brands%ROWTYPE; v_email text := lower(btrim(coalesce(p_email, ''))); v_m brand_members%ROWTYPE; n int;
BEGIN
  IF v_email = '' OR p_role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_b FROM brands WHERE id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF lower(btrim(coalesce(v_b.email, ''))) = v_email THEN RETURN jsonb_build_object('outcome', 'owner_is_owner'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE brand_id = p_brand_id AND lower(email) = v_email AND status IN ('pending','accepted') LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'already_has_access', 'status', v_m.status, 'role', v_m.role, 'member_id', v_m.id); END IF;
  IF NOT coalesce(p_multi, false) THEN
    IF p_role <> 'booker' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
    SELECT * INTO v_m FROM brand_members WHERE brand_id = p_brand_id AND role <> 'owner' AND status IN ('pending','accepted') LIMIT 1;
    IF FOUND THEN RETURN jsonb_build_object('outcome', 'booker_already_designated', 'email', v_m.email, 'status', v_m.status); END IF;
    IF EXISTS (SELECT 1 FROM brands b WHERE lower(b.email) = v_email)
       OR EXISTS (SELECT 1 FROM brand_members m WHERE lower(m.email) = v_email AND m.status IN ('pending','accepted')) THEN
      RETURN jsonb_build_object('outcome', 'email_in_use');
    END IF;
  ELSE
    SELECT count(*) INTO n FROM brand_members WHERE brand_id = p_brand_id AND role <> 'owner' AND status IN ('pending','accepted');
    IF n >= 20 THEN RETURN jsonb_build_object('outcome', 'too_many_people'); END IF;
  END IF;
  INSERT INTO brand_members (brand_id, email, name, role, status, invited_by_email)
  VALUES (p_brand_id, v_email, nullif(btrim(coalesce(p_name, '')), ''), p_role, 'pending', lower(btrim(coalesce(p_by_email, ''))))
  RETURNING * INTO v_m;
  RETURN jsonb_build_object('outcome', 'ok', 'member', jsonb_build_object('id', v_m.id, 'email', v_m.email, 'name', v_m.name, 'role', v_m.role, 'status', v_m.status, 'created_at', v_m.created_at),
                            'brand_name', v_b.company_name);
END $$;
REVOKE ALL ON FUNCTION brand_access_grant(uuid, text, text, text, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_grant(uuid, text, text, text, text, boolean) TO service_role;

-- Change the level of someone who already has (or was offered) access. Owner action.
CREATE OR REPLACE FUNCTION brand_access_set_role(p_brand_id uuid, p_member_id uuid, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE;
BEGIN
  IF p_role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id AND brand_id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_m.role = 'owner' THEN RETURN jsonb_build_object('outcome', 'not_a_booker'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'already_revoked'); END IF;
  UPDATE brand_members SET role = p_role WHERE id = v_m.id;
  RETURN jsonb_build_object('outcome', 'ok', 'role', p_role);
END $$;
REVOKE ALL ON FUNCTION brand_access_set_role(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_set_role(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. The invitation functions of 0098 / 0102, re-created so they serve both levels. Same signatures, same lock
--    order (membership first, then the invitation), same outcomes. The only change is role IN ('booker','manager').
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booker_invite_issue(p_member_id uuid, p_brand_id uuid, p_token_hash text, p_ttl_hours integer, p_by_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; v_id uuid; v_exp timestamptz;
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id AND brand_id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_m.role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'not_a_booker'); END IF;
  IF v_m.status <> 'pending' THEN RETURN jsonb_build_object('outcome', 'not_pending', 'status', v_m.status); END IF;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
  v_exp := now() + make_interval(hours => greatest(1, coalesce(p_ttl_hours, 24)));
  INSERT INTO brand_booker_invites (member_id, brand_id, email, token_hash, expires_at, created_by_email)
  VALUES (v_m.id, v_m.brand_id, v_m.email, p_token_hash, v_exp, lower(btrim(p_by_email))) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'ok', 'invite_id', v_id, 'email', v_m.email, 'expires_at', v_exp);
END $$;
REVOKE ALL ON FUNCTION booker_invite_issue(uuid, uuid, text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_invite_issue(uuid, uuid, text, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION booker_invite_code_set(p_token_hash text, p_code_hash text, p_ttl_minutes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i brand_booker_invites%ROWTYPE; v_m brand_members%ROWTYPE; v_brand record;
BEGIN
  SELECT member_id INTO v_i.member_id FROM brand_booker_invites WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE id = v_i.member_id FOR UPDATE;                       -- membership first
  SELECT * INTO v_i FROM brand_booker_invites WHERE token_hash = p_token_hash FOR UPDATE;          -- then the invitation
  IF v_i.used_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'already_used'); END IF;
  IF v_i.superseded_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'superseded'); END IF;
  IF v_i.expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'expired'); END IF;
  IF v_m.role NOT IN ('booker','manager') OR v_m.status <> 'pending' OR v_m.brand_id <> v_i.brand_id THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  UPDATE brand_booker_invites SET code_hash = p_code_hash, code_expires_at = now() + make_interval(mins => greatest(5, coalesce(p_ttl_minutes, 30))), code_attempts = 0 WHERE id = v_i.id;
  SELECT company_name INTO v_brand FROM brands WHERE id = v_i.brand_id;
  RETURN jsonb_build_object('outcome', 'ok', 'brand_name', v_brand.company_name, 'email', v_i.email, 'booker_name', v_m.name, 'role', v_m.role);
END $$;
REVOKE ALL ON FUNCTION booker_invite_code_set(text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_invite_code_set(text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION booker_accept(p_token_hash text, p_code_hash text, p_session_token text, p_terms_version text, p_terms_digest text DEFAULT NULL, p_session_days integer DEFAULT 30, p_max_attempts integer DEFAULT 6)
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
  IF v_m.role NOT IN ('booker','manager') OR v_m.brand_id <> v_i.brand_id OR lower(v_m.email) <> lower(v_i.email) THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
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
  UPDATE brand_members SET status = 'accepted', accepted_at = now(), last_active_at = now(), terms_accepted_at = now(), terms_version = btrim(p_terms_version), terms_digest = nullif(btrim(coalesce(p_terms_digest, '')), '') WHERE id = v_m.id;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (v_m.brand_id, p_session_token, lower(v_m.email), v_exp);
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'expires_at', v_exp, 'terms_version', btrim(p_terms_version));
END $$;
REVOKE ALL ON FUNCTION booker_accept(text, text, text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_accept(text, text, text, text, text, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION booker_revoke(p_brand_id uuid, p_member_id uuid, p_by_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; n int;
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id AND brand_id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_m.role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'not_a_booker'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'already_revoked'); END IF;
  UPDATE brand_members SET status = 'revoked', revoked_at = now(), revoked_by_email = lower(btrim(p_by_email)) WHERE id = v_m.id;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
  DELETE FROM brand_account_sessions WHERE brand_id = p_brand_id AND lower(email) = lower(v_m.email);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('outcome', 'ok', 'sessions_ended', n);
END $$;
REVOKE ALL ON FUNCTION booker_revoke(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_revoke(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. The signed-in person: their brands, their pending invitations, accept, decline, switch.
--    Every function takes the email from the caller's verified session, never from a request body.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brand_access_list(p_email text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH e AS (SELECT lower(btrim(coalesce(p_email, ''))) AS email),
  mine AS (
    SELECT b.id AS brand_id, coalesce(nullif(btrim(b.company_name), ''), b.email) AS company_name, 'owner'::text AS access, true AS is_own, b.logo_url, NULL::uuid AS member_id, 0 AS ord
      FROM brands b, e WHERE e.email <> '' AND lower(b.email) = e.email
    UNION ALL
    SELECT b.id, coalesce(nullif(btrim(b.company_name), ''), b.email), CASE WHEN m.role = 'manager' THEN 'full' ELSE 'booking' END, false, b.logo_url, m.id, 1
      FROM brand_members m JOIN brands b ON b.id = m.brand_id, e
     WHERE e.email <> '' AND lower(m.email) = e.email AND m.status = 'accepted' AND m.role IN ('booker','manager') AND lower(coalesce(b.email, '')) <> e.email
  ),
  inv AS (
    SELECT m.id AS member_id, b.id AS brand_id, coalesce(nullif(btrim(b.company_name), ''), b.email) AS company_name,
           CASE WHEN m.role = 'manager' THEN 'full' ELSE 'booking' END AS access, m.invited_by_email, m.created_at
      FROM brand_members m JOIN brands b ON b.id = m.brand_id, e
     WHERE e.email <> '' AND lower(m.email) = e.email AND m.status = 'pending' AND m.role IN ('booker','manager')
  )
  SELECT jsonb_build_object(
    'brands', coalesce((SELECT jsonb_agg(jsonb_build_object('brand_id', brand_id, 'company_name', company_name, 'access', access, 'is_own', is_own, 'logo_url', logo_url, 'member_id', member_id) ORDER BY ord, lower(company_name)) FROM mine), '[]'::jsonb),
    'invites', coalesce((SELECT jsonb_agg(jsonb_build_object('member_id', member_id, 'brand_id', brand_id, 'company_name', company_name, 'access', access, 'invited_by_email', invited_by_email, 'invited_at', created_at) ORDER BY created_at DESC) FROM inv), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION brand_access_list(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_list(text) TO service_role;

-- Accept an invitation while signed in as the invited address (the session is the proof of the address, exactly as
-- the emailed code is on the public acceptance page). No session is issued: the person already has one.
CREATE OR REPLACE FUNCTION brand_access_accept_signed_in(p_member_id uuid, p_email text, p_terms_version text, p_terms_digest text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF v_email = '' OR p_member_id IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF coalesce(btrim(p_terms_version), '') = '' THEN RETURN jsonb_build_object('outcome', 'terms_required'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND OR lower(v_m.email) <> v_email OR v_m.role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'revoked'); END IF;
  IF v_m.status = 'accepted' THEN RETURN jsonb_build_object('outcome', 'already_accepted', 'brand_id', v_m.brand_id); END IF;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
  UPDATE brand_members SET status = 'accepted', accepted_at = now(), terms_accepted_at = now(), terms_version = btrim(p_terms_version), terms_digest = nullif(btrim(coalesce(p_terms_digest, '')), '') WHERE id = v_m.id;
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'role', v_m.role);
END $$;
REVOKE ALL ON FUNCTION brand_access_accept_signed_in(uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_accept_signed_in(uuid, text, text, text) TO service_role;

-- Decline a pending invitation, or leave a brand one has access to. Never the owner row.
CREATE OR REPLACE FUNCTION brand_access_leave(p_member_id uuid, p_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND OR v_email = '' OR lower(v_m.email) <> v_email OR v_m.role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'already_revoked'); END IF;
  UPDATE brand_members SET status = 'revoked', revoked_at = now(), revoked_by_email = v_email WHERE id = v_m.id;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
  DELETE FROM brand_account_sessions WHERE brand_id = v_m.brand_id AND lower(email) = v_email;
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id);
END $$;
REVOKE ALL ON FUNCTION brand_access_leave(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_leave(uuid, text) TO service_role;

-- Switch the active brand of a live session. The session's OWN email must own the target or hold accepted access to
-- it. The token is rotated: the new session row is written and the old one deleted in the same transaction, so no
-- cached copy of the old token keeps acting for the previous brand.
CREATE OR REPLACE FUNCTION brand_session_switch(p_session_token text, p_brand_id uuid, p_new_session_token text, p_session_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s brand_account_sessions%ROWTYPE; v_email text; v_role text; v_member uuid; v_exp timestamptz; v_name text;
BEGIN
  IF coalesce(p_session_token, '') = '' OR coalesce(p_new_session_token, '') = '' OR p_brand_id IS NULL OR p_new_session_token = p_session_token THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_s FROM brand_account_sessions WHERE session_token = p_session_token FOR UPDATE;
  IF NOT FOUND OR v_s.expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'no_session'); END IF;
  v_email := lower(btrim(coalesce(v_s.email, '')));
  IF v_email = '' THEN RETURN jsonb_build_object('outcome', 'no_session'); END IF;
  SELECT coalesce(nullif(btrim(company_name), ''), email) INTO v_name FROM brands WHERE id = p_brand_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_allowed'); END IF;
  IF EXISTS (SELECT 1 FROM brands WHERE id = p_brand_id AND lower(email) = v_email) THEN
    v_role := 'owner';
    SELECT id INTO v_member FROM brand_members WHERE brand_id = p_brand_id AND lower(email) = v_email AND role = 'owner' LIMIT 1;
  ELSE
    SELECT id, role INTO v_member, v_role FROM brand_members
     WHERE brand_id = p_brand_id AND lower(email) = v_email AND status = 'accepted' AND role IN ('booker','manager') FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_allowed'); END IF;
  END IF;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (p_brand_id, p_new_session_token, v_email, v_exp);
  DELETE FROM brand_account_sessions WHERE id = v_s.id;
  IF v_member IS NOT NULL THEN UPDATE brand_members SET last_active_at = now() WHERE id = v_member; END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', p_brand_id, 'company_name', v_name, 'role', v_role, 'expires_at', v_exp, 'changed', v_s.brand_id <> p_brand_id);
END $$;
REVOKE ALL ON FUNCTION brand_session_switch(text, uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_session_switch(text, uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Access requests: the rep asks, the owner approves from the email.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_access_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id         uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  requester_email  text NOT NULL,
  requester_name   text,
  requester_note   text,
  requested_role   text NOT NULL CHECK (requested_role IN ('booker','manager')),
  owner_email      text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','superseded')),
  decided_at       timestamptz,
  decided_role     text CHECK (decided_role IS NULL OR decided_role IN ('booker','manager')),
  decided_via      text CHECK (decided_via IS NULL OR decided_via IN ('email_link','portal')),
  member_id        uuid REFERENCES brand_members(id) ON DELETE RESTRICT,
  terms_version    text,
  terms_digest     text,
  delivery_status  text CHECK (delivery_status IS NULL OR delivery_status IN ('sent','failed','not_configured')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_access_requests_brand_idx ON brand_access_requests (brand_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS brand_access_requests_one_pending_idx ON brand_access_requests (brand_id, lower(requester_email)) WHERE status = 'pending';
ALTER TABLE brand_access_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brand_access_requests FROM public, anon, authenticated;

-- The rep (signed in, so the address is proven) asks for access to the brand whose owner sign-in is p_owner_email.
-- An unknown owner email answers 'no_brand'; the API turns every non-ok outcome that would reveal whether an account
-- exists into the same generic reply.
CREATE OR REPLACE FUNCTION brand_access_request_create(p_requester_email text, p_requester_name text, p_note text, p_owner_email text, p_role text,
                                                       p_token_hash text, p_ttl_hours integer, p_terms_version text, p_terms_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b brands%ROWTYPE; v_req text := lower(btrim(coalesce(p_requester_email, ''))); v_owner text := lower(btrim(coalesce(p_owner_email, '')));
        v_m brand_members%ROWTYPE; v_id uuid; v_exp timestamptz; n int;
BEGIN
  IF v_req = '' OR v_owner = '' OR coalesce(p_token_hash, '') = '' OR p_role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF coalesce(btrim(p_terms_version), '') = '' THEN RETURN jsonb_build_object('outcome', 'terms_required'); END IF;
  IF v_req = v_owner THEN RETURN jsonb_build_object('outcome', 'own_brand'); END IF;
  SELECT * INTO v_b FROM brands WHERE lower(email) = v_owner FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_brand'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE brand_id = v_b.id AND lower(email) = v_req AND status IN ('pending','accepted') LIMIT 1;
  IF FOUND AND v_m.status = 'accepted' THEN RETURN jsonb_build_object('outcome', 'already_has_access', 'brand_id', v_b.id); END IF;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'invite_pending', 'brand_id', v_b.id, 'member_id', v_m.id); END IF;
  SELECT count(*) INTO n FROM brand_access_requests WHERE brand_id = v_b.id AND created_at > now() - interval '24 hours';
  IF n >= 20 THEN RETURN jsonb_build_object('outcome', 'too_many'); END IF;
  UPDATE brand_access_requests SET status = 'superseded', decided_at = now() WHERE brand_id = v_b.id AND lower(requester_email) = v_req AND status = 'pending';
  v_exp := now() + make_interval(hours => greatest(1, coalesce(p_ttl_hours, 336)));
  INSERT INTO brand_access_requests (brand_id, requester_email, requester_name, requester_note, requested_role, owner_email, token_hash, expires_at, terms_version, terms_digest)
  VALUES (v_b.id, v_req, nullif(left(btrim(coalesce(p_requester_name, '')), 120), ''), nullif(left(btrim(coalesce(p_note, '')), 300), ''), p_role, v_owner, p_token_hash, v_exp,
          btrim(p_terms_version), nullif(btrim(coalesce(p_terms_digest, '')), ''))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'ok', 'request_id', v_id, 'brand_id', v_b.id, 'brand_name', coalesce(nullif(btrim(v_b.company_name), ''), v_b.email), 'owner_email', v_owner, 'expires_at', v_exp);
END $$;
REVOKE ALL ON FUNCTION brand_access_request_create(text, text, text, text, text, text, integer, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_request_create(text, text, text, text, text, text, integer, text, text) TO service_role;

-- What the owner sees on the approval page. Reads only.
CREATE OR REPLACE FUNCTION brand_access_request_view(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r brand_access_requests%ROWTYPE; v_b brands%ROWTYPE; v_state text;
BEGIN
  SELECT * INTO v_r FROM brand_access_requests WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_b FROM brands WHERE id = v_r.brand_id;
  v_state := CASE WHEN v_r.status <> 'pending' THEN v_r.status
                  WHEN v_r.expires_at <= now() THEN 'expired'
                  WHEN lower(coalesce(v_b.email, '')) <> lower(v_r.owner_email) THEN 'invalid'
                  ELSE 'pending' END;
  IF v_state = 'invalid' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'state', v_state, 'brand_name', coalesce(nullif(btrim(v_b.company_name), ''), v_b.email),
    'requester_email', v_r.requester_email, 'requester_name', v_r.requester_name, 'requester_note', v_r.requester_note,
    'requested_role', v_r.requested_role, 'decided_role', v_r.decided_role, 'created_at', v_r.created_at, 'expires_at', v_r.expires_at);
END $$;
REVOKE ALL ON FUNCTION brand_access_request_view(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_request_view(text) TO service_role;

-- The owner's answer. Two ways in, one function:
--   * from the email: p_token_hash (the token is the proof; p_request_id and p_brand_id are null)
--   * from the portal: p_request_id + p_brand_id from the owner's own session (p_token_hash null)
-- Locks the brand row first (the same lock brand_access_grant takes), then the request. Approval writes the accepted
-- membership in the same transaction. A request is answered once.
CREATE OR REPLACE FUNCTION brand_access_request_decide(p_token_hash text, p_request_id uuid, p_brand_id uuid, p_decision text, p_role text, p_by_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r brand_access_requests%ROWTYPE; v_b brands%ROWTYPE; v_m brand_members%ROWTYPE; v_role text; v_via text; n int;
BEGIN
  IF p_decision NOT IN ('approve','decline') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF coalesce(p_token_hash, '') <> '' THEN
    SELECT * INTO v_r FROM brand_access_requests WHERE token_hash = p_token_hash;
    v_via := 'email_link';
  ELSIF p_request_id IS NOT NULL AND p_brand_id IS NOT NULL THEN
    SELECT * INTO v_r FROM brand_access_requests WHERE id = p_request_id AND brand_id = p_brand_id;
    v_via := 'portal';
  ELSE
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  IF v_r.id IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_b FROM brands WHERE id = v_r.brand_id FOR UPDATE;                                 -- brand first
  SELECT * INTO v_r FROM brand_access_requests WHERE id = v_r.id FOR UPDATE;                        -- then the request
  IF v_b.id IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_r.status <> 'pending' THEN RETURN jsonb_build_object('outcome', 'already_decided', 'status', v_r.status, 'decided_role', v_r.decided_role); END IF;
  IF v_r.expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'expired'); END IF;
  -- bound to the owner the request was sent to: if the brand's owner sign-in changed since, the link is void
  IF lower(coalesce(v_b.email, '')) <> lower(v_r.owner_email) THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_via = 'portal' AND lower(btrim(coalesce(p_by_email, ''))) <> lower(v_r.owner_email) THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;

  IF p_decision = 'decline' THEN
    UPDATE brand_access_requests SET status = 'declined', decided_at = now(), decided_via = v_via WHERE id = v_r.id;
    RETURN jsonb_build_object('outcome', 'ok', 'decision', 'declined', 'brand_id', v_b.id, 'brand_name', coalesce(nullif(btrim(v_b.company_name), ''), v_b.email), 'requester_email', v_r.requester_email);
  END IF;

  v_role := CASE WHEN p_role IN ('booker','manager') THEN p_role ELSE v_r.requested_role END;
  SELECT * INTO v_m FROM brand_members WHERE brand_id = v_b.id AND lower(email) = lower(v_r.requester_email) AND status IN ('pending','accepted') FOR UPDATE;
  IF FOUND AND v_m.role = 'owner' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF FOUND THEN
    UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
    UPDATE brand_members SET role = v_role, status = 'accepted', accepted_at = coalesce(accepted_at, now()),
           terms_accepted_at = coalesce(terms_accepted_at, v_r.created_at), terms_version = coalesce(terms_version, v_r.terms_version), terms_digest = coalesce(terms_digest, v_r.terms_digest)
     WHERE id = v_m.id;
  ELSE
    SELECT count(*) INTO n FROM brand_members WHERE brand_id = v_b.id AND role <> 'owner' AND status IN ('pending','accepted');
    IF n >= 20 THEN RETURN jsonb_build_object('outcome', 'too_many_people'); END IF;
    INSERT INTO brand_members (brand_id, email, name, role, status, accepted_at, invited_by_email, terms_accepted_at, terms_version, terms_digest)
    VALUES (v_b.id, lower(v_r.requester_email), v_r.requester_name, v_role, 'accepted', now(), lower(v_r.owner_email), v_r.created_at, v_r.terms_version, v_r.terms_digest)
    RETURNING * INTO v_m;
  END IF;
  UPDATE brand_access_requests SET status = 'approved', decided_at = now(), decided_role = v_role, decided_via = v_via, member_id = v_m.id WHERE id = v_r.id;
  RETURN jsonb_build_object('outcome', 'ok', 'decision', 'approved', 'role', v_role, 'member_id', v_m.id, 'brand_id', v_b.id,
    'brand_name', coalesce(nullif(btrim(v_b.company_name), ''), v_b.email), 'requester_email', v_r.requester_email, 'requester_name', v_r.requester_name);
END $$;
REVOKE ALL ON FUNCTION brand_access_request_decide(text, uuid, uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_request_decide(text, uuid, uuid, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. redeem_brand_signup (0097), re-created. Same signature and outcomes; the result also carries brand_count.
--    * the email's OWN brand resolves first (0064, unchanged)
--    * otherwise the accepted access used most recently (then the one accepted most recently)
--    * otherwise a PENDING invitation never resolves and never creates a brand: outcome 'invite_pending'
--    * otherwise a new brand, as before
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_brand_signup(
  p_email        text,
  p_code_hash    text,
  p_session_token text,
  p_session_days  integer DEFAULT 30,
  p_max_attempts  integer DEFAULT 6
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email    text := lower(btrim(p_email));
  v_ch       email_verifications;
  v_brand_id uuid;
  v_created  boolean := false;
  v_payload  jsonb;
  v_expires  timestamptz;
  v_m        brand_members%ROWTYPE;
  v_count    int;
BEGIN
  IF v_email = '' OR coalesce(p_code_hash,'') = '' OR coalesce(p_session_token,'') = '' THEN
    RETURN jsonb_build_object('outcome','invalid');
  END IF;

  SELECT * INTO v_ch FROM email_verifications
   WHERE lower(email) = v_email AND purpose = 'brand_signup' AND consumed_at IS NULL
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','already_used'); END IF;
  IF v_ch.expires_at <= now() THEN RETURN jsonb_build_object('outcome','expired'); END IF;
  IF v_ch.attempts >= p_max_attempts THEN RETURN jsonb_build_object('outcome','too_many_attempts'); END IF;
  IF v_ch.code_hash <> p_code_hash THEN
    UPDATE email_verifications SET attempts = attempts + 1 WHERE id = v_ch.id;
    RETURN jsonb_build_object('outcome','invalid');
  END IF;

  UPDATE email_verifications SET consumed_at = now() WHERE id = v_ch.id;
  v_payload := coalesce(v_ch.payload, '{}'::jsonb);

  SELECT id INTO v_brand_id FROM brands WHERE lower(email) = v_email LIMIT 1;

  IF v_brand_id IS NOT NULL THEN
    UPDATE brands SET
      company_name = CASE WHEN coalesce(btrim(company_name),'') = '' THEN coalesce(nullif(btrim(v_payload->>'company_name'),''), company_name) ELSE company_name END,
      contact_name = CASE WHEN coalesce(btrim(contact_name),'') = '' THEN coalesce(nullif(btrim(v_payload->>'contact_name'),''), contact_name) ELSE contact_name END,
      phone        = CASE WHEN coalesce(btrim(phone),'') = '' THEN coalesce(nullif(btrim(v_payload->>'phone'),''), phone) ELSE phone END,
      is_verified  = true,
      updated_at   = now()
    WHERE id = v_brand_id;
    UPDATE brand_members SET role = 'owner' WHERE brand_id = v_brand_id AND lower(email) = v_email AND role IS DISTINCT FROM 'owner';
    INSERT INTO brand_members (brand_id, email, name, role)
    VALUES (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'owner')
    ON CONFLICT DO NOTHING;
  ELSE
    SELECT * INTO v_m FROM brand_members
     WHERE lower(email) = v_email AND status = 'accepted' AND role IN ('booker','manager')
     ORDER BY last_active_at DESC NULLS LAST, accepted_at DESC LIMIT 1;
    IF FOUND THEN
      v_brand_id := v_m.brand_id;    -- accepted access signs in to that brand; the brand itself is not touched
    ELSE
      SELECT * INTO v_m FROM brand_members WHERE lower(email) = v_email AND status = 'pending' ORDER BY created_at DESC LIMIT 1;
      IF FOUND THEN
        -- BK-3: a pending invitation is accepted only through the explicit acceptance step.
        RETURN jsonb_build_object('outcome','invite_pending', 'brand_id', v_m.brand_id);
      END IF;
      INSERT INTO brands (email, company_name, contact_name, phone, is_verified)
      VALUES (v_email, coalesce(nullif(btrim(v_payload->>'company_name'), ''), v_email), nullif(btrim(v_payload->>'contact_name'), ''), nullif(btrim(v_payload->>'phone'), ''), true)
      RETURNING id INTO v_brand_id;
      v_created := true;
      BEGIN
        INSERT INTO brand_members (brand_id, email, name, role)
        VALUES (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'owner');
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'email_in_use' USING errcode = 'unique_violation';
      END;
    END IF;
  END IF;

  v_expires := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at)
  VALUES (v_brand_id, p_session_token, v_email, v_expires);

  SELECT (SELECT count(*) FROM brands WHERE lower(email) = v_email)
       + (SELECT count(*) FROM brand_members m JOIN brands b ON b.id = m.brand_id
           WHERE lower(m.email) = v_email AND m.status = 'accepted' AND m.role IN ('booker','manager') AND lower(coalesce(b.email, '')) <> v_email)
    INTO v_count;

  RETURN jsonb_build_object('outcome','ok', 'brand_id', v_brand_id, 'expires_at', v_expires, 'created', v_created, 'brand_count', v_count);
END $$;
REVOKE ALL ON FUNCTION public.redeem_brand_signup(text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_brand_signup(text, text, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Post-conditions (literal-only).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM brand_members WHERE role NOT IN ('owner','booker','manager');
  IF n <> 0 THEN RAISE EXCEPTION '0121 postcondition: % row(s) outside the role domain', n; END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE tablename = 'brand_members' AND indexname IN ('brand_members_one_identity_idx','brand_members_one_booker_idx');
  IF n <> 0 THEN RAISE EXCEPTION '0121 postcondition: the one-identity indexes are still present (%/0)', n; END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE tablename = 'brand_members' AND indexname IN ('brand_members_live_identity_idx','brand_members_one_owner_idx','brand_members_one_owned_brand_idx');
  IF n <> 3 THEN RAISE EXCEPTION '0121 postcondition: membership indexes missing (%/3)', n; END IF;
  IF to_regclass('public.brand_access_requests') IS NULL THEN RAISE EXCEPTION '0121 postcondition: brand_access_requests missing'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
    AND p.proname IN ('brand_access_grant','brand_access_set_role','brand_access_list','brand_access_accept_signed_in','brand_access_leave','brand_session_switch',
                      'brand_access_request_create','brand_access_request_view','brand_access_request_decide');
  IF n <> 9 THEN RAISE EXCEPTION '0121 postcondition: functions missing (%/9)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
    AND p.proname IN ('booker_accept','booker_revoke','booker_invite_issue','booker_invite_code_set','redeem_brand_signup');
  IF n <> 5 THEN RAISE EXCEPTION '0121 postcondition: a re-created function has more than one overload (% for 5 names)', n; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'brand_members' AND column_name = 'last_active_at';
  IF n <> 1 THEN RAISE EXCEPTION '0121 postcondition: brand_members.last_active_at missing'; END IF;
END $$;
