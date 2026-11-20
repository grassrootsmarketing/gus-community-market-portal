-- 0122_multi_brand_access_corrections.sql (2026-11-19)
-- ============================================================================
-- One person, many brands: corrections from Codex's review of 0121 (findings 3 and 4, Demohub-Multi-Brand-Access-
-- Review-and-Claude-Work-Order-2026-11-19.md). Forward migration on top of 0121, which is applied on
-- demohub-rebuild-check and nowhere else. The production paste carries 0121 and 0122 in ONE transaction, so production
-- never holds 0121 without these corrections.
--
-- Finding 3. With the multi-brand switch off, "one identity per email" was checked under the BRAND row lock only. Two
--   grants of the same address by two different brands locked two different rows, both saw no live membership, and
--   both inserted; the index that used to refuse the second insert was dropped by 0121. Now every writer that can
--   create a brand identity for an address first takes ONE transaction-scoped advisory lock keyed by the normalised
--   address (_brand_identity_lock). Lock order, everywhere: email, then the brand row, then the membership row, then
--   the invitation or request row.
--     writers that take it: brand_access_grant, redeem_brand_signup, brand_access_request_decide, and the insert
--     trigger for any membership row written directly (below).
--     writers that do not need it: acceptance, revocation, leaving and level changes act on a membership row that
--     already exists (a pending row already counts as the address's identity), and owner rows are only ever written
--     for the address that already is brands.email.
--
-- Finding 4. The build that is live before this release (main 622af19) does not call brand_access_grant: it reads, then
--   inserts the booker row directly. 0121 removed the two indexes and the trigger rule that backed those reads, so
--   between the paste and the deploy the reads were the only guard. The insert trigger now applies the 0097 rules, under
--   the same email and brand locks, to every non-owner membership row that is NOT written by one of the access
--   functions: booking only, one live person per brand, one identity per email. So an old build, an old deployment URL
--   or any future direct writer cannot create a second identity or a second booker, whatever the switches say. The
--   access functions mark their own insert with a transaction-local setting after they have made the checks themselves.
--
-- No row is changed. Same signatures. No begin/commit here.
-- ============================================================================

DO $$
BEGIN
  IF to_regprocedure('brand_access_grant(uuid,text,text,text,text,boolean)') IS NULL OR to_regclass('public.brand_access_requests') IS NULL THEN
    RAISE EXCEPTION '0122 precondition: 0121 objects are missing (apply 0121 first).';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 1. The one lock for "who is this email on Demohub's brand side". Transaction scoped; released at commit or rollback.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _brand_identity_lock(p_email text) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('demohub.brand_identity:' || lower(btrim(coalesce(p_email, ''))), 0))
$$;
REVOKE ALL ON FUNCTION _brand_identity_lock(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION _brand_identity_lock(text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. The insert trigger: owner defaults as before, plus the 0097 rules for a directly written non-owner row.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brand_members_owner_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.role = 'owner' THEN
    NEW.status := 'accepted';
    IF NEW.accepted_at IS NULL THEN NEW.accepted_at := now(); END IF;
  ELSIF NEW.status IN ('pending','accepted') AND coalesce(current_setting('demohub.member_write', true), '') <> 'function' THEN
    -- A direct write (the pre-0121 build, or anything that is not an access function). Same locks, same order.
    PERFORM _brand_identity_lock(NEW.email);
    PERFORM 1 FROM brands b WHERE b.id = NEW.brand_id FOR UPDATE;
    IF NEW.role <> 'booker' THEN
      RAISE EXCEPTION 'direct_member_write_refused: only the access functions create a % row', NEW.role USING errcode = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM brands b WHERE lower(b.email) = NEW.email)
       OR EXISTS (SELECT 1 FROM brand_members m WHERE lower(m.email) = NEW.email AND m.status IN ('pending','accepted')) THEN
      RAISE EXCEPTION 'email_in_use: % already has a brand identity', NEW.email USING errcode = 'unique_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM brand_members m WHERE m.brand_id = NEW.brand_id AND m.role <> 'owner' AND m.status IN ('pending','accepted')) THEN
      RAISE EXCEPTION 'booker_already_designated: this brand already has a live booker' USING errcode = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. brand_access_grant (0121), re-created: the email lock first, and its insert marked as checked.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION brand_access_grant(p_brand_id uuid, p_email text, p_name text, p_role text, p_by_email text, p_multi boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_b brands%ROWTYPE; v_email text := lower(btrim(coalesce(p_email, ''))); v_m brand_members%ROWTYPE; n int;
BEGIN
  IF v_email = '' OR p_role NOT IN ('booker','manager') THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  PERFORM _brand_identity_lock(v_email);                                 -- email first (0122), then the brand
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
  PERFORM set_config('demohub.member_write', 'function', true);          -- this insert was checked above, under the locks
  INSERT INTO brand_members (brand_id, email, name, role, status, invited_by_email)
  VALUES (p_brand_id, v_email, nullif(btrim(coalesce(p_name, '')), ''), p_role, 'pending', lower(btrim(coalesce(p_by_email, ''))))
  RETURNING * INTO v_m;
  PERFORM set_config('demohub.member_write', '', true);
  RETURN jsonb_build_object('outcome', 'ok', 'member', jsonb_build_object('id', v_m.id, 'email', v_m.email, 'name', v_m.name, 'role', v_m.role, 'status', v_m.status, 'created_at', v_m.created_at),
                            'brand_name', v_b.company_name);
END $$;
REVOKE ALL ON FUNCTION brand_access_grant(uuid, text, text, text, text, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_grant(uuid, text, text, text, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. brand_access_request_decide (0121), re-created: the requester's email lock first, then brand, then request.
-- ---------------------------------------------------------------------------------------------
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
  PERFORM _brand_identity_lock(v_r.requester_email);                                                -- email first (0122)
  SELECT * INTO v_b FROM brands WHERE id = v_r.brand_id FOR UPDATE;                                 -- then the brand
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
    PERFORM set_config('demohub.member_write', 'function', true);
    INSERT INTO brand_members (brand_id, email, name, role, status, accepted_at, invited_by_email, terms_accepted_at, terms_version, terms_digest)
    VALUES (v_b.id, lower(v_r.requester_email), v_r.requester_name, v_role, 'accepted', now(), lower(v_r.owner_email), v_r.created_at, v_r.terms_version, v_r.terms_digest)
    RETURNING * INTO v_m;
    PERFORM set_config('demohub.member_write', '', true);
  END IF;
  UPDATE brand_access_requests SET status = 'approved', decided_at = now(), decided_role = v_role, decided_via = v_via, member_id = v_m.id WHERE id = v_r.id;
  RETURN jsonb_build_object('outcome', 'ok', 'decision', 'approved', 'role', v_role, 'member_id', v_m.id, 'brand_id', v_b.id,
    'brand_name', coalesce(nullif(btrim(v_b.company_name), ''), v_b.email), 'requester_email', v_r.requester_email, 'requester_name', v_r.requester_name);
END $$;
REVOKE ALL ON FUNCTION brand_access_request_decide(text, uuid, uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION brand_access_request_decide(text, uuid, uuid, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. redeem_brand_signup (0121), re-created: the email lock before anything is read or written.
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

  -- 0122: the same email lock every writer of a brand identity takes first. A sign-up that would create a brand and a
  -- grant for the same address now run one after the other, so each sees what the other wrote.
  PERFORM _brand_identity_lock(v_email);

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
-- 6. Post-conditions (literal-only).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  IF to_regprocedure('_brand_identity_lock(text)') IS NULL THEN RAISE EXCEPTION '0122 postcondition: _brand_identity_lock missing'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
    AND p.proname IN ('brand_access_grant','brand_access_request_decide','redeem_brand_signup') AND position('_brand_identity_lock' in pg_get_functiondef(p.oid)) > 0;
  IF n <> 3 THEN RAISE EXCEPTION '0122 postcondition: a writer does not take the email lock (%/3)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
    AND p.proname IN ('brand_access_grant','brand_access_request_decide','redeem_brand_signup','brand_members_owner_defaults');
  IF n <> 4 THEN RAISE EXCEPTION '0122 postcondition: a re-created function has more than one overload (% for 4 names)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public'
    AND p.proname = 'brand_members_owner_defaults' AND position('direct_member_write_refused' in pg_get_functiondef(p.oid)) > 0;
  IF n <> 1 THEN RAISE EXCEPTION '0122 postcondition: the insert trigger does not carry the direct-write rules'; END IF;
END $$;
