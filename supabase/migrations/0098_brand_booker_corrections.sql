-- 0098_brand_booker_corrections.sql
-- ============================================================================
-- Designated brand booker, corrections from Codex's closure response (BC-1, BC-2, BC-3, BC-6), 2026-10-17.
-- Forward migration on top of 0097 (which is applied on demohub-rebuild-check; neither is on production yet).
--
-- BC-1  A booker's items are rebuilt from the brand's saved catalog INSIDE the database, by id. The client sends ids;
--       names, sizes and barcodes come from brands.products at creation time. Unknown or duplicate ids are refused.
-- BC-2  Booker authorization is transactional: booking_create_as_member locks the membership row FOR SHARE (so
--       booker_revoke's FOR UPDATE serializes against it), requires accepted status, locks the retailer row FOR SHARE and
--       recomputes the current policy hash from the retailer's own text, and requires an active, unexpired agreement for
--       that hash (also locked FOR SHARE, so a supersession waits). booking_create_with_code applies the same checks
--       when the payload names a member. Serial order: if a revocation or supersession commits first, the booking is
--       refused; if the booking commits first, it stays attributed and owner-manageable.
-- BC-3  One lock order everywhere: MEMBERSHIP FIRST, then invitation. The acceptance code is bound to the invitation
--       (brand_booker_invites.code_hash, code_expires_at, code_attempts), never a login code; booker_accept checks the
--       code, consumes the invitation, accepts the membership and issues the session in one transaction, with bounded
--       attempts (6) after which the invitation is superseded. booker_invite_issue supersedes and inserts under the
--       membership lock, so concurrent resend/accept has one serialized outcome.
-- BC-6  brand_booker_invites records delivery state (sent, failed, not_configured) so designation can tell the truth.
-- Forward-only. No row rewrites.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.brand_booker_invites') IS NULL OR to_regclass('public.brand_members') IS NULL THEN
    RAISE EXCEPTION '0098 precondition: 0097 objects are missing (apply 0097 first).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Invitation columns (BC-3, BC-6)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS code_expires_at timestamptz;
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS delivery_detail text;
ALTER TABLE brand_booker_invites ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE brand_booker_invites DROP CONSTRAINT IF EXISTS brand_booker_invites_delivery_check;
ALTER TABLE brand_booker_invites ADD CONSTRAINT brand_booker_invites_delivery_check CHECK (delivery_status IS NULL OR delivery_status IN ('sent','failed','not_configured'));

-- ---------------------------------------------------------------------------------------------
-- 2. Policy hash in SQL: the same bytes the application hashes (demo policy, separator, cancellation policy,
--    separator, TOS version), with the application's defaults passed in so the rule lives in one place.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agreement_policy_hash(p_demo_policy text, p_cancellation_policy text, p_default_demo text, p_default_cancel text, p_tos_version text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(extensions.digest(convert_to(
    coalesce(nullif(p_demo_policy, ''), p_default_demo) || E'\n---\n' || coalesce(nullif(p_cancellation_policy, ''), p_default_cancel) || E'\n---tos:' || p_tos_version, 'UTF8'), 'sha256'), 'hex')
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Shared check: the member may act for the brand right now (BC-2). Locks the member row FOR SHARE.
--    For a booker: the retailer row FOR SHARE, the current policy hash, and an active agreement FOR SHARE.
--    Returns the member row. Raises check_violation with a stable code on refusal.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _booker_authorize(p_member_id uuid, p_brand_id uuid, p_retailer_id uuid, p_default_demo text, p_default_cancel text, p_tos_version text)
RETURNS brand_members LANGUAGE plpgsql AS $$
DECLARE v_m brand_members%ROWTYPE; v_r record; v_hash text; v_a record;
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booker_not_a_member' USING errcode = 'check_violation'; END IF;
  IF v_m.brand_id <> p_brand_id OR v_m.status <> 'accepted' THEN RAISE EXCEPTION 'booker_not_a_member' USING errcode = 'check_violation'; END IF;
  IF v_m.role = 'booker' THEN
    SELECT id, demo_policy, cancellation_policy INTO v_r FROM retailers WHERE id = p_retailer_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'retailer_not_found' USING errcode = 'check_violation'; END IF;
    v_hash := agreement_policy_hash(v_r.demo_policy, v_r.cancellation_policy, p_default_demo, p_default_cancel, p_tos_version);
    SELECT id, policy_hash, expires_at INTO v_a FROM brand_retailer_agreements
     WHERE brand_id = p_brand_id AND retailer_id = p_retailer_id AND superseded_at IS NULL
     ORDER BY signed_at DESC LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'agreement_required_owner:never_signed' USING errcode = 'check_violation'; END IF;
    IF v_a.expires_at IS NOT NULL AND v_a.expires_at < now() THEN RAISE EXCEPTION 'agreement_required_owner:expired' USING errcode = 'check_violation'; END IF;
    IF v_a.policy_hash IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'agreement_required_owner:policy_changed' USING errcode = 'check_violation'; END IF;
  END IF;
  RETURN v_m;
END $$;

-- The snapshot from the catalog (BC-1): ids in, catalog items out, in the order given. Unknown or duplicate ids refuse.
CREATE OR REPLACE FUNCTION _catalog_snapshot(p_brand_id uuid, p_item_ids text[])
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_products jsonb; v_out jsonb := '[]'::jsonb; v_id text; v_item jsonb; v_seen text[] := '{}';
BEGIN
  IF p_item_ids IS NULL OR array_length(p_item_ids, 1) IS NULL THEN RAISE EXCEPTION 'products_required' USING errcode = 'check_violation'; END IF;
  IF array_length(p_item_ids, 1) > 40 THEN RAISE EXCEPTION 'too_many_items' USING errcode = 'check_violation'; END IF;
  SELECT products INTO v_products FROM brands WHERE id = p_brand_id FOR SHARE;
  IF v_products IS NULL OR jsonb_typeof(v_products) <> 'array' THEN RAISE EXCEPTION 'items_not_in_catalog' USING errcode = 'check_violation'; END IF;
  FOREACH v_id IN ARRAY p_item_ids LOOP
    IF v_id = ANY (v_seen) THEN RAISE EXCEPTION 'duplicate_item' USING errcode = 'check_violation'; END IF;
    v_seen := v_seen || v_id;
    SELECT e INTO v_item FROM jsonb_array_elements(v_products) e WHERE e->>'id' = v_id AND coalesce(e->>'name', '') <> '' LIMIT 1;
    IF v_item IS NULL THEN RAISE EXCEPTION 'items_not_in_catalog' USING errcode = 'check_violation'; END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_item->>'id', 'name', v_item->>'name', 'size', coalesce(v_item->>'size', ''), 'sku', coalesce(v_item->>'sku', ''), 'upc', coalesce(v_item->>'upc', ''),
      'distributor', coalesce(v_item->>'distributor', ''), 'distributor_other', coalesce(v_item->>'distributor_other', ''), 'distributor_item_number', coalesce(v_item->>'distributor_item_number', ''),
      'case_pack', CASE WHEN jsonb_typeof(v_item->'case_pack') = 'number' THEN v_item->'case_pack' ELSE 'null'::jsonb END, 'notes', coalesce(v_item->>'notes', '')));
  END LOOP;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. booking_create_as_member (BC-1, BC-2): the ordinary (non-code) booking path for a member, one transaction.
--    The payload carries the booking columns the route already builds; items come from the catalog by id.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_create_as_member(p_member_id uuid, p_brand_id uuid, p_retailer_id uuid, p_item_ids text[], p_payload jsonb,
                                                    p_default_demo text, p_default_cancel text, p_tos_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; v_snap jsonb; v_b bookings%ROWTYPE;
BEGIN
  v_m := _booker_authorize(p_member_id, p_brand_id, p_retailer_id, p_default_demo, p_default_cancel, p_tos_version);
  v_snap := _catalog_snapshot(p_brand_id, p_item_ids);
  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, contact_phone, demo_date, demo_time, duration_hours,
                        product, notes, product_skus, needs_electricity, status, held_expires_at, payment_status, amount_paid,
                        booked_by_member_id, booked_by_email, booked_by_name)
  VALUES (p_retailer_id, (p_payload->>'venue_id')::uuid, p_brand_id, p_payload->>'brand_name', p_payload->>'contact_name', p_payload->>'contact_email', p_payload->>'contact_phone',
          (p_payload->>'demo_date')::date, p_payload->>'demo_time', (p_payload->>'duration_hours')::numeric,
          p_payload->>'product', p_payload->>'notes', v_snap, (p_payload->>'needs_electricity')::boolean, p_payload->>'status',
          (p_payload->>'held_expires_at')::timestamptz, coalesce(p_payload->>'payment_status', 'unpaid'), coalesce((p_payload->>'amount_paid')::int, 0),
          v_m.id, v_m.email, coalesce(nullif(p_payload->>'booked_by_name', ''), v_m.name))
  RETURNING * INTO v_b;
  RETURN jsonb_build_object('ok', true, 'booking_id', v_b.id, 'status', v_b.status, 'items', jsonb_array_length(v_snap));
END $$;
REVOKE ALL ON FUNCTION booking_create_as_member(uuid, uuid, uuid, text[], jsonb, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booking_create_as_member(uuid, uuid, uuid, text[], jsonb, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. booking_create_with_code (0085, 0097): same signature; when the payload names a member it is authorized under lock
--    and, for a booker, the items are rebuilt from the catalog (payload.item_ids) and the agreement is checked.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_create_with_code(p_op_key text, p_fingerprint text, p_brand_id uuid, p_retailer_id uuid, p_payload jsonb, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op booking_operations%ROWTYPE; v_b bookings%ROWTYPE; v_r record; v_res jsonb; v_member uuid; v_m brand_members%ROWTYPE; v_items jsonb; v_ids text[];
BEGIN
  INSERT INTO booking_operations (op_key, brand_id, fingerprint) VALUES (p_op_key, p_brand_id, p_fingerprint) ON CONFLICT (op_key) DO NOTHING;
  SELECT * INTO v_op FROM booking_operations WHERE op_key = p_op_key FOR UPDATE;
  IF v_op.brand_id <> p_brand_id OR v_op.fingerprint <> p_fingerprint THEN RAISE EXCEPTION 'op_key_reused' USING errcode = 'check_violation'; END IF;
  IF v_op.result IS NOT NULL THEN RETURN v_op.result || jsonb_build_object('replay', true); END IF;

  v_member := nullif(p_payload->>'booked_by_member_id', '')::uuid;
  v_items := p_payload->'product_skus';
  IF v_member IS NOT NULL THEN
    v_m := _booker_authorize(v_member, p_brand_id, p_retailer_id, p_payload->>'default_demo_policy', p_payload->>'default_cancellation_policy', p_payload->>'tos_version');
    IF v_m.role = 'booker' THEN
      SELECT array_agg(x) INTO v_ids FROM jsonb_array_elements_text(coalesce(p_payload->'item_ids', '[]'::jsonb)) x;
      v_items := _catalog_snapshot(p_brand_id, v_ids);
    END IF;
  END IF;

  SELECT * INTO v_r FROM booking_code_check(p_code, p_retailer_id);
  IF NOT v_r.ok THEN RAISE EXCEPTION 'code_rejected:%', v_r.reason USING errcode = 'check_violation'; END IF;

  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, contact_phone, demo_date, demo_time, duration_hours,
                        product, notes, product_skus, needs_electricity, status, held_expires_at, payment_status, amount_paid,
                        booked_by_member_id, booked_by_email, booked_by_name)
  VALUES (p_retailer_id, (p_payload->>'venue_id')::uuid, p_brand_id, p_payload->>'brand_name', p_payload->>'contact_name', p_payload->>'contact_email', p_payload->>'contact_phone',
          (p_payload->>'demo_date')::date, p_payload->>'demo_time', (p_payload->>'duration_hours')::numeric,
          p_payload->>'product', p_payload->>'notes', v_items, (p_payload->>'needs_electricity')::boolean, p_payload->>'status',
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
-- 6. Invitations: issue, set code, accept (BC-3). Membership lock FIRST in every function; booker_revoke (0097)
--    already locks the member first.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booker_invite_issue(p_member_id uuid, p_brand_id uuid, p_token_hash text, p_ttl_hours integer, p_by_email text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m brand_members%ROWTYPE; v_id uuid; v_exp timestamptz;
BEGIN
  SELECT * INTO v_m FROM brand_members WHERE id = p_member_id AND brand_id = p_brand_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_m.role <> 'booker' THEN RETURN jsonb_build_object('outcome', 'not_a_booker'); END IF;
  IF v_m.status <> 'pending' THEN RETURN jsonb_build_object('outcome', 'not_pending', 'status', v_m.status); END IF;
  UPDATE brand_booker_invites SET superseded_at = now() WHERE member_id = v_m.id AND used_at IS NULL AND superseded_at IS NULL;
  v_exp := now() + make_interval(hours => greatest(1, coalesce(p_ttl_hours, 24)));
  INSERT INTO brand_booker_invites (member_id, brand_id, email, token_hash, expires_at, created_by_email)
  VALUES (v_m.id, v_m.brand_id, v_m.email, p_token_hash, v_exp, lower(btrim(p_by_email))) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'ok', 'invite_id', v_id, 'email', v_m.email, 'expires_at', v_exp);
END $$;
REVOKE ALL ON FUNCTION booker_invite_issue(uuid, uuid, text, integer, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_invite_issue(uuid, uuid, text, integer, text) TO service_role;

-- accept-start: validates the invitation and binds a fresh code to it. Returns the brand and booker for the page.
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
  IF v_m.role <> 'booker' OR v_m.status <> 'pending' OR v_m.brand_id <> v_i.brand_id THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  UPDATE brand_booker_invites SET code_hash = p_code_hash, code_expires_at = now() + make_interval(mins => greatest(5, coalesce(p_ttl_minutes, 30))), code_attempts = 0 WHERE id = v_i.id;
  SELECT company_name INTO v_brand FROM brands WHERE id = v_i.brand_id;
  RETURN jsonb_build_object('outcome', 'ok', 'brand_name', v_brand.company_name, 'email', v_i.email, 'booker_name', v_m.name);
END $$;
REVOKE ALL ON FUNCTION booker_invite_code_set(text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_invite_code_set(text, text, integer) TO service_role;

-- accept: the code bound to THIS invitation, consumed with the invitation, the membership and the session in one
-- transaction. Six wrong codes supersede the invitation. The old 0097 signature is dropped (one callable shape).
DROP FUNCTION IF EXISTS booker_accept(text, text, text, integer);
CREATE FUNCTION booker_accept(p_token_hash text, p_code_hash text, p_session_token text, p_session_days integer DEFAULT 30, p_max_attempts integer DEFAULT 6)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i brand_booker_invites%ROWTYPE; v_m brand_members%ROWTYPE; v_exp timestamptz;
BEGIN
  IF coalesce(p_token_hash, '') = '' OR coalesce(p_code_hash, '') = '' OR coalesce(p_session_token, '') = '' THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
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
  UPDATE brand_members SET status = 'accepted', accepted_at = now() WHERE id = v_m.id;
  v_exp := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  INSERT INTO brand_account_sessions (brand_id, session_token, email, expires_at) VALUES (v_m.brand_id, p_session_token, lower(v_m.email), v_exp);
  RETURN jsonb_build_object('outcome', 'ok', 'brand_id', v_m.brand_id, 'member_id', v_m.id, 'expires_at', v_exp);
END $$;
REVOKE ALL ON FUNCTION booker_accept(text, text, text, integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booker_accept(text, text, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Post-conditions (literal-only).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'brand_booker_invites' AND column_name IN ('code_hash','code_expires_at','code_attempts','delivery_status','delivery_detail','delivered_at');
  IF n <> 6 THEN RAISE EXCEPTION '0098 postcondition: invite columns missing (%/6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname IN ('agreement_policy_hash','_booker_authorize','_catalog_snapshot','booking_create_as_member','booker_invite_issue','booker_invite_code_set');
  IF n <> 6 THEN RAISE EXCEPTION '0098 postcondition: functions missing (%/6)', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booker_accept';
  IF n <> 1 THEN RAISE EXCEPTION '0098 postcondition: booker_accept must have exactly one overload, found %', n; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booking_create_with_code';
  IF n <> 1 THEN RAISE EXCEPTION '0098 postcondition: booking_create_with_code must have exactly one overload, found %', n; END IF;
  IF agreement_policy_hash(NULL, NULL, 'a', 'b', 'v') <> encode(extensions.digest(convert_to('a' || E'\n---\n' || 'b' || E'\n---tos:' || 'v', 'UTF8'), 'sha256'), 'hex') THEN
    RAISE EXCEPTION '0098 postcondition: policy hash helper does not match the application formula';
  END IF;
END $$;
