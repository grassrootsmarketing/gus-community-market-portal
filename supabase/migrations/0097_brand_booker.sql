-- 0097_brand_booker.sql
-- ============================================================================
-- Designated brand booker (David, 2026-10-17; Codex BK-1 to BK-5). One brand account, one owner, at most one
-- separately authenticated booker with booking-only permissions. Design: Demohub-Brand-Booker-Role-Design-for-
-- Codex-2026-10-17.md; review: Demohub-Brand-Booker-Design-Review-for-Claude-2026-10-17.md.
--
-- Membership becomes role + state. role: owner | booker. status: pending | accepted | revoked. History is kept
-- (revoked rows stay), so the old unique key on (brand_id, lower(email)) is replaced by partial unique indexes:
--   * one live row per (brand, email)                      status <> 'revoked'
--   * ONE identity per email across all brands (BK-1)       status in ('pending','accepted')
--   * at most one pending-or-accepted booker per brand      role = 'booker'
--   * exactly one owner row per brand                       role = 'owner'
-- Preconditions stop the migration if any membership row is not the canonical owner of its brand (BK-2: never
-- silently reclassify admin / viewer rows). Brands without an owner row get one (the brand's own email).
--
-- Invitations get their own table with hashed tokens and a dedicated purpose (BK-3). Acceptance and revocation
-- are single transactions (booker_accept, booker_revoke). Bookings and demos carry who booked them
-- (booked_by_member_id plus an email and name snapshot, BK-5); the demos copy is filled by trigger at creation so
-- every creation path (worker promotion, admin confirm, materialize) carries it. booking_create_with_code reads the
-- attribution from the server-built payload; its signature is unchanged, so no second callable overload exists.
-- redeem_brand_signup (0064) is re-created: a pending invitation never resolves to a brand and never creates one;
-- an accepted booker signs in to the brand it belongs to; an email that is a live booker cannot create a brand.
-- Forward-only. No row rewrites beyond the owner-role normalisation it asserts first.
-- ============================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Preconditions (BK-2): every existing membership row must be its brand's canonical owner.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM brand_members m LEFT JOIN brands b ON b.id = m.brand_id
   WHERE b.id IS NULL OR b.email IS NULL OR lower(m.email) <> lower(b.email) OR m.role NOT IN ('owner','admin');
  IF n > 0 THEN
    RAISE EXCEPTION '0097 precondition: % membership row(s) are not the canonical owner of their brand (orphan, email differs from brands.email, or a non-owner role). Review them before applying.', n;
  END IF;
  SELECT count(*) INTO n FROM (SELECT lower(email) FROM brand_members GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION '0097 precondition: % email(s) hold more than one membership. One identity per email is the rule (BK-1). Review before applying.', n;
  END IF;
  IF to_regclass('public.brand_account_sessions') IS NULL OR to_regclass('public.brands') IS NULL OR to_regclass('public.bookings') IS NULL OR to_regclass('public.demos') IS NULL THEN
    RAISE EXCEPTION '0097 precondition: a required table is missing.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Canonical owner rows: role 'owner' for the brand's own email (0053 wrote 'admin' before 0064), and a row for
--    every brand that has none.
-- ---------------------------------------------------------------------------------------------
UPDATE brand_members m SET role = 'owner'
  FROM brands b WHERE b.id = m.brand_id AND lower(m.email) = lower(b.email) AND m.role <> 'owner';

INSERT INTO brand_members (brand_id, email, name, role)
SELECT b.id, lower(btrim(b.email)), b.contact_name, 'owner'
  FROM brands b
 WHERE b.email IS NOT NULL AND btrim(b.email) <> ''
   AND NOT EXISTS (SELECT 1 FROM brand_members m WHERE m.brand_id = b.id AND lower(m.email) = lower(b.email));

-- ---------------------------------------------------------------------------------------------
-- 2. Role and state columns.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS status text;
UPDATE brand_members SET status = 'accepted' WHERE status IS NULL;
ALTER TABLE brand_members ALTER COLUMN status SET NOT NULL;
ALTER TABLE brand_members ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE brand_members ADD COLUMN IF NOT EXISTS revoked_by_email text;
UPDATE brand_members SET accepted_at = created_at WHERE status = 'accepted' AND accepted_at IS NULL;
ALTER TABLE brand_members ALTER COLUMN role DROP DEFAULT;
ALTER TABLE brand_members DROP CONSTRAINT IF EXISTS brand_members_role_check;
ALTER TABLE brand_members ADD CONSTRAINT brand_members_role_check CHECK (role IN ('owner','booker'));
ALTER TABLE brand_members DROP CONSTRAINT IF EXISTS brand_members_status_check;
ALTER TABLE brand_members ADD CONSTRAINT brand_members_status_check CHECK (status IN ('pending','accepted','revoked'));
ALTER TABLE brand_members DROP CONSTRAINT IF EXISTS brand_members_state_dates_check;
ALTER TABLE brand_members ADD CONSTRAINT brand_members_state_dates_check CHECK (
  (status <> 'accepted' OR accepted_at IS NOT NULL) AND (status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- Owner rows are always accepted, whichever path inserts them (redeem_brand_signup, brand-account backfill).
-- BK-1 at the database: a booker row for an email that OWNS a brand (brands.email) is refused here, with the same
-- unique_violation the one-identity index raises, so the API maps both to one answer. An owner row for an email that is
-- a live member elsewhere is refused by brand_members_one_identity_idx.
CREATE OR REPLACE FUNCTION brand_members_owner_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  IF NEW.role = 'owner' THEN
    NEW.status := 'accepted';
    IF NEW.accepted_at IS NULL THEN NEW.accepted_at := now(); END IF;
  ELSIF NEW.role = 'booker' AND NEW.status IN ('pending','accepted') THEN
    IF EXISTS (SELECT 1 FROM brands b WHERE lower(b.email) = NEW.email) THEN
      RAISE EXCEPTION 'email_in_use: % owns a brand account' , NEW.email USING errcode = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS brand_members_owner_defaults ON brand_members;
CREATE TRIGGER brand_members_owner_defaults BEFORE INSERT ON brand_members FOR EACH ROW EXECUTE FUNCTION brand_members_owner_defaults();

-- ---------------------------------------------------------------------------------------------
-- 3. Indexes: history kept, one live identity.
-- ---------------------------------------------------------------------------------------------
DROP INDEX IF EXISTS brand_members_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS brand_members_live_identity_idx ON brand_members (brand_id, lower(email)) WHERE status <> 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS brand_members_one_identity_idx ON brand_members (lower(email)) WHERE status IN ('pending','accepted');
CREATE UNIQUE INDEX IF NOT EXISTS brand_members_one_booker_idx ON brand_members (brand_id) WHERE role = 'booker' AND status IN ('pending','accepted');
CREATE UNIQUE INDEX IF NOT EXISTS brand_members_one_owner_idx ON brand_members (brand_id) WHERE role = 'owner';

-- ---------------------------------------------------------------------------------------------
-- 4. Invitations (BK-3): hashed token, dedicated purpose, bound to the membership incarnation.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_booker_invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        uuid NOT NULL REFERENCES brand_members(id) ON DELETE RESTRICT,
  brand_id         uuid NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  email            text NOT NULL,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  superseded_at    timestamptz,
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS brand_booker_invites_member_idx ON brand_booker_invites (member_id, created_at DESC);
ALTER TABLE brand_booker_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON brand_booker_invites FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Attribution (BK-5): who booked. Membership rows are never deleted (revoked instead), RESTRICT guards it.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by_member_id uuid REFERENCES brand_members(id) ON DELETE RESTRICT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by_email text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by_name text;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS booked_by_member_id uuid REFERENCES brand_members(id) ON DELETE RESTRICT;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS booked_by_email text;
ALTER TABLE demos ADD COLUMN IF NOT EXISTS booked_by_name text;
CREATE INDEX IF NOT EXISTS bookings_booked_by_member_idx ON bookings (booked_by_member_id) WHERE booked_by_member_id IS NOT NULL;

-- Every demo creation path (0077/0078 promotion, admin confirm, materialize) copies the booking's attribution.
CREATE OR REPLACE FUNCTION demos_copy_booked_by() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_b record;
BEGIN
  IF NEW.booking_id IS NOT NULL AND NEW.booked_by_member_id IS NULL THEN
    SELECT booked_by_member_id, booked_by_email, booked_by_name INTO v_b FROM bookings WHERE id = NEW.booking_id;
    IF FOUND THEN
      NEW.booked_by_member_id := v_b.booked_by_member_id;
      NEW.booked_by_email := coalesce(NEW.booked_by_email, v_b.booked_by_email);
      NEW.booked_by_name := coalesce(NEW.booked_by_name, v_b.booked_by_name);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS demos_copy_booked_by ON demos;
CREATE TRIGGER demos_copy_booked_by BEFORE INSERT ON demos FOR EACH ROW EXECUTE FUNCTION demos_copy_booked_by();

-- ---------------------------------------------------------------------------------------------
-- 6. booking_create_with_code (0085): the server-built payload carries the attribution. Same signature.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_create_with_code(p_op_key text, p_fingerprint text, p_brand_id uuid, p_retailer_id uuid, p_payload jsonb, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op booking_operations%ROWTYPE; v_b bookings%ROWTYPE; v_r record; v_res jsonb; v_member uuid;
BEGIN
  INSERT INTO booking_operations (op_key, brand_id, fingerprint) VALUES (p_op_key, p_brand_id, p_fingerprint) ON CONFLICT (op_key) DO NOTHING;
  SELECT * INTO v_op FROM booking_operations WHERE op_key = p_op_key FOR UPDATE;
  IF v_op.brand_id <> p_brand_id OR v_op.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'op_key_reused' USING errcode = 'check_violation'; END IF;
  IF v_op.result IS NOT NULL THEN RETURN v_op.result || jsonb_build_object('replay', true); END IF;

  -- BK-5: the attribution must name a live member of THIS brand (the server sets it; a forged id fails here).
  v_member := nullif(p_payload->>'booked_by_member_id', '')::uuid;
  IF v_member IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brand_members m WHERE m.id = v_member AND m.brand_id = p_brand_id AND m.status = 'accepted') THEN
    RAISE EXCEPTION 'booked_by_not_a_member' USING errcode = 'check_violation';
  END IF;

  SELECT * INTO v_r FROM booking_code_check(p_code, p_retailer_id);
  IF NOT v_r.ok THEN RAISE EXCEPTION 'code_rejected:%', v_r.reason USING errcode = 'check_violation'; END IF;

  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, contact_phone, demo_date, demo_time, duration_hours,
                        product, notes, product_skus, needs_electricity, status, held_expires_at, payment_status, amount_paid,
                        booked_by_member_id, booked_by_email, booked_by_name)
  VALUES (p_retailer_id, (p_payload->>'venue_id')::uuid, p_brand_id, p_payload->>'brand_name', p_payload->>'contact_name', p_payload->>'contact_email', p_payload->>'contact_phone',
          (p_payload->>'demo_date')::date, p_payload->>'demo_time', (p_payload->>'duration_hours')::numeric,
          p_payload->>'product', p_payload->>'notes', p_payload->'product_skus', (p_payload->>'needs_electricity')::boolean, p_payload->>'status',
          (p_payload->>'held_expires_at')::timestamptz, coalesce(p_payload->>'payment_status', 'unpaid'), coalesce((p_payload->>'amount_paid')::int, 0),
          v_member, nullif(p_payload->>'booked_by_email', ''), nullif(p_payload->>'booked_by_name', ''))
  RETURNING * INTO v_b;

  SELECT * INTO v_r FROM booking_code_redeem(p_code, p_retailer_id, v_b.id, p_brand_id);
  IF NOT v_r.ok THEN RAISE EXCEPTION 'code_rejected:%', v_r.reason USING errcode = 'check_violation'; END IF;

  v_res := jsonb_build_object('ok', true, 'booking_id', v_b.id, 'fee_waived', v_r.waived_fee, 'waived_lead_time', v_r.waived_lead_time, 'target_status', v_r.target_status, 'code_id', v_r.code_id);
  UPDATE booking_operations SET booking_id = v_b.id, result = v_res WHERE op_key = p_op_key;
  RETURN v_res || jsonb_build_object('replay', false);
END $$;
REVOKE ALL ON FUNCTION booking_create_with_code(text, text, uuid, uuid, jsonb, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booking_create_with_code(text, text, uuid, uuid, jsonb, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Acceptance and revocation, each one transaction (BK-3).
-- ---------------------------------------------------------------------------------------------
-- booker_accept: the invite token (by hash) must be unused, unexpired, not superseded, and belong to a PENDING booker
-- row whose email matches the verified email. Marks the invite used, the member accepted, and issues the session.
CREATE OR REPLACE FUNCTION booker_accept(p_token_hash text, p_verified_email text, p_session_token text, p_session_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i brand_booker_invites%ROWTYPE; v_m brand_members%ROWTYPE; v_email text := lower(btrim(p_verified_email)); v_exp timestamptz;
BEGIN
  IF coalesce(p_token_hash, '') = '' OR v_email = '' OR coalesce(p_session_token, '') = '' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  SELECT * INTO v_i FROM brand_booker_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_i.used_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'already_used'); END IF;
  IF v_i.superseded_at IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'superseded'); END IF;
  IF v_i.expires_at <= now() THEN RETURN jsonb_build_object('outcome', 'expired'); END IF;
  IF lower(v_i.email) <> v_email THEN RETURN jsonb_build_object('outcome', 'wrong_email'); END IF;
  SELECT * INTO v_m FROM brand_members WHERE id = v_i.member_id FOR UPDATE;
  IF NOT FOUND OR v_m.brand_id <> v_i.brand_id OR lower(v_m.email) <> v_email OR v_m.role <> 'booker' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  IF v_m.status = 'revoked' THEN RETURN jsonb_build_object('outcome', 'revoked'); END IF;
  IF v_m.status = 'accepted' THEN RETURN jsonb_build_object('outcome', 'already_accepted'); END IF;
  UPDATE brand_booker_invites SET used_at = now() WHERE id = v_i.id;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND id <> v_i.id AND used_at IS NULL AND superseded_at IS NULL;
  UPDATE brand_members SET status = 'accepted', accepted_at = now() WHERE id = v_m.id;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (v_m.brand_id, p_session_token, v_email, v_exp);
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'expires_at', v_exp);
END $$;
REVOKE ALL ON FUNCTION booker_accept(text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_accept(text, text, text, integer) TO service_role;

-- booker_revoke: owner action. Ends the booker's sessions and open invitations in the same transaction.
CREATE OR REPLACE FUNCTION booker_revoke(p_brand_id uuid, p_member_id uuid, p_by_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; n int;
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id AND brand_id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_m.role <> 'booker' THEN RETURN jsonb_build_object('outcome', 'not_a_booker'); END IF;
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
-- 8. redeem_brand_signup (0064), re-created for the booker rules (BK-1, BK-3).
--    * the email's OWN brand resolves first (unchanged)
--    * otherwise an ACCEPTED booker signs in to its brand, with no brand mutation
--    * a PENDING invitation never resolves and never creates a brand: outcome 'invite_pending'
--    * a revoked or unknown email creates a new brand as before; the one-identity index refuses an email that is a live
--      member elsewhere, reported as 'email_in_use'
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
    SELECT * INTO v_m FROM brand_members WHERE lower(email) = v_email AND status IN ('pending','accepted') ORDER BY created_at DESC LIMIT 1;
    IF FOUND AND v_m.status = 'pending' THEN
      -- BK-3: a pending invitation is accepted only through booker_accept, after the explicit acceptance step.
      RETURN jsonb_build_object('outcome','invite_pending', 'brand_id', v_m.brand_id);
    ELSIF FOUND AND v_m.status = 'accepted' AND v_m.role = 'booker' THEN
      v_brand_id := v_m.brand_id;    -- an accepted booker signs in to its brand; the brand itself is not touched
    ELSE
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

  RETURN jsonb_build_object('outcome','ok', 'brand_id', v_brand_id, 'expires_at', v_expires, 'created', v_created);
END $$;
REVOKE ALL ON FUNCTION public.redeem_brand_signup(text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_brand_signup(text, text, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Post-conditions (literal-only).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM brand_members WHERE role NOT IN ('owner','booker') OR status NOT IN ('pending','accepted','revoked');
  IF n <> 0 THEN RAISE EXCEPTION '0097 postcondition: % row(s) outside the role/state domain', n; END IF;
  SELECT count(*) INTO n FROM brands b WHERE b.email IS NOT NULL AND btrim(b.email) <> '' AND NOT EXISTS (SELECT 1 FROM brand_members m WHERE m.brand_id = b.id AND m.role = 'owner' AND lower(m.email) = lower(b.email));
  IF n <> 0 THEN RAISE EXCEPTION '0097 postcondition: % brand(s) without a canonical owner row', n; END IF;
  SELECT count(*) INTO n FROM pg_indexes WHERE tablename = 'brand_members' AND indexname IN ('brand_members_live_identity_idx','brand_members_one_identity_idx','brand_members_one_booker_idx','brand_members_one_owner_idx');
  IF n <> 4 THEN RAISE EXCEPTION '0097 postcondition: membership indexes missing (%/4)', n; END IF;
  IF to_regclass('public.brand_booker_invites') IS NULL THEN RAISE EXCEPTION '0097 postcondition: brand_booker_invites missing'; END IF;
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name IN ('bookings','demos') AND column_name IN ('booked_by_member_id','booked_by_email','booked_by_name');
  IF n <> 6 THEN RAISE EXCEPTION '0097 postcondition: attribution columns missing (%/6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname IN ('booker_accept','booker_revoke','demos_copy_booked_by','brand_members_owner_defaults');
  IF n <> 4 THEN RAISE EXCEPTION '0097 postcondition: functions missing (%/4)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booking_create_with_code';
  IF n <> 1 THEN RAISE EXCEPTION '0097 postcondition: booking_create_with_code must have exactly one overload, found %', n; END IF;
END $$;
