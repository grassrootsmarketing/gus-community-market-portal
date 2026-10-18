-- 0100_brand_booker_retry_safe.sql
-- ============================================================================
-- Designated brand booker, Codex revision 2 decision BR2-1 (2026-10-17): the ordinary booker booking is retry-safe.
-- booking_create_as_member (0098) inserted a new booking on every call. A lost response followed by a resubmission
-- could create a second pending booking when capacity allowed. It now uses the durable operation pattern of 0085:
--   * an operation key bound to the brand AND the member, with the request fingerprint
--   * insert-or-lock the operation row FOR UPDATE, so two identical submissions serialize and the second replays
--   * the result is stored with the creation in the same transaction; a replay returns it
--   * the same key with a different brand, member or fingerprint is refused (op_key_reused)
-- Live authorization still runs on every NEW creation; a replay returns the original identity and creates nothing.
-- Forward-only on top of 0097 and 0098. Numbered 0100 because 0099 is the retailer demo-move refund-state migration on its own branch.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.booking_operations') IS NULL THEN RAISE EXCEPTION '0100 precondition: booking_operations (0085) is missing.'; END IF;
  IF to_regprocedure('_booker_authorize(uuid,uuid,uuid,text,text,text)') IS NULL OR to_regprocedure('_catalog_snapshot(uuid,text[])') IS NULL THEN
    RAISE EXCEPTION '0100 precondition: 0098 functions are missing.';
  END IF;
END $$;

ALTER TABLE booking_operations ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES brand_members(id) ON DELETE RESTRICT;

DROP FUNCTION IF EXISTS booking_create_as_member(uuid, uuid, uuid, text[], jsonb, text, text, text);
CREATE FUNCTION booking_create_as_member(p_op_key text, p_fingerprint text, p_member_id uuid, p_brand_id uuid, p_retailer_id uuid, p_item_ids text[], p_payload jsonb,
                                         p_default_demo text, p_default_cancel text, p_tos_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op booking_operations%ROWTYPE; v_m brand_members%ROWTYPE; v_snap jsonb; v_b bookings%ROWTYPE; v_res jsonb;
BEGIN
  IF coalesce(p_op_key, '') = '' OR coalesce(p_fingerprint, '') = '' THEN RAISE EXCEPTION 'op_key_required' USING errcode = 'check_violation'; END IF;
  -- durable identity for this request (0085 pattern): insert, then lock. A concurrent twin waits here and replays.
  INSERT INTO booking_operations (op_key, brand_id, member_id, fingerprint) VALUES (p_op_key, p_brand_id, p_member_id, p_fingerprint) ON CONFLICT (op_key) DO NOTHING;
  SELECT * INTO v_op FROM booking_operations WHERE op_key = p_op_key FOR UPDATE;
  IF v_op.brand_id <> p_brand_id OR v_op.member_id IS DISTINCT FROM p_member_id OR v_op.fingerprint <> p_fingerprint THEN
    RAISE EXCEPTION 'op_key_reused' USING errcode = 'check_violation';
  END IF;
  IF v_op.result IS NOT NULL THEN RETURN v_op.result || jsonb_build_object('replay', true); END IF;

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
  v_res := jsonb_build_object('ok', true, 'booking_id', v_b.id, 'status', v_b.status, 'items', jsonb_array_length(v_snap));
  UPDATE booking_operations SET booking_id = v_b.id, result = v_res WHERE op_key = p_op_key;
  RETURN v_res || jsonb_build_object('replay', false);
END $$;
REVOKE ALL ON FUNCTION booking_create_as_member(text, text, uuid, uuid, uuid, text[], jsonb, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booking_create_as_member(text, text, uuid, uuid, uuid, text[], jsonb, text, text, text) TO service_role;

-- The code path records the member on its operation row too, so a replay is bound to the same person.
CREATE OR REPLACE FUNCTION booking_create_with_code(p_op_key text, p_fingerprint text, p_brand_id uuid, p_retailer_id uuid, p_payload jsonb, p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op booking_operations%ROWTYPE; v_b bookings%ROWTYPE; v_r record; v_res jsonb; v_member uuid; v_m brand_members%ROWTYPE; v_items jsonb; v_ids text[];
BEGIN
  v_member := nullif(p_payload->>'booked_by_member_id', '')::uuid;
  INSERT INTO booking_operations (op_key, brand_id, member_id, fingerprint) VALUES (p_op_key, p_brand_id, v_member, p_fingerprint) ON CONFLICT (op_key) DO NOTHING;
  SELECT * INTO v_op FROM booking_operations WHERE op_key = p_op_key FOR UPDATE;
  IF v_op.brand_id <> p_brand_id OR v_op.fingerprint <> p_fingerprint OR (v_op.member_id IS NOT NULL AND v_op.member_id IS DISTINCT FROM v_member) THEN RAISE EXCEPTION 'op_key_reused' USING errcode = 'check_violation'; END IF;
  IF v_op.result IS NOT NULL THEN RETURN v_op.result || jsonb_build_object('replay', true); END IF;

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

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'booking_operations' AND column_name = 'member_id';
  IF n <> 1 THEN RAISE EXCEPTION '0100 postcondition: booking_operations.member_id missing'; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booking_create_as_member';
  IF n <> 1 THEN RAISE EXCEPTION '0100 postcondition: booking_create_as_member must have exactly one overload, found %', n; END IF;
  IF to_regprocedure('booking_create_as_member(text,text,uuid,uuid,uuid,text[],jsonb,text,text,text)') IS NULL THEN RAISE EXCEPTION '0100 postcondition: new booking_create_as_member signature missing'; END IF;
  SELECT count(*) INTO n FROM pg_proc WHERE proname = 'booking_create_with_code';
  IF n <> 1 THEN RAISE EXCEPTION '0100 postcondition: booking_create_with_code must have exactly one overload, found %', n; END IF;
END $$;
