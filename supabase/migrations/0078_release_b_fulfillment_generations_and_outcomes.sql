-- 0078_release_b_fulfillment_generations_and_outcomes.sql
-- Codex "Release B — third closure review" (2026-09-11), C1–C3. Forward-only; 0077 untouched.
--
--   C1  booking_fulfillments.generation: a captured hold's outbox row is re-issued as a NEW generation
--       (apply_verified_payment), which invalidates the held-stage lease in the same statement; claims
--       return the generation and complete_fulfillment() requires owner + generation. An old worker
--       cannot finish or modify the paid generation. projection_anomalies() gains two stranded-payment
--       branches. The 6-argument complete_fulfillment() is DROPPED on purpose: a deployment that still
--       calls it cannot record progress on any row after this migration (cutover fence).
--   C2  booking_transition(): an action whose terminal target is ALREADY the current state converges
--       idempotently (audited fields, projection) and reports ok=true, reason='already_applied'; every
--       other mismatch remains ok=false 'state_changed'.
--   C3  promote_paid with target 'pending' against a booking that is already 'confirmed' reports
--       ok=false, reason='already_advanced' (never a downgrade) so the worker can finish/supersede its
--       remaining work against the current state.
--
-- Definitions below are the 0065 / 0038 / 0077 bodies with the literal edits marked [0078].

-- ---------------------------------------------------------------------------------------------
-- 1. C1 — generation column
-- ---------------------------------------------------------------------------------------------
ALTER TABLE booking_fulfillments ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------------------------
-- 2. C1 — apply_verified_payment (0065 body): the reopened paid work is a new generation
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid; v_auto boolean;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  IF p_payment_intent IS NULL OR p_charge IS NULL OR p_amount IS NULL OR p_currency IS NULL THEN
    v_case := _open_case('payment_contradiction','pi-missing:'||p_session_id,'missing_pi_charge_amount_or_currency',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;

  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id;
  IF NOT FOUND THEN
    v_case := _open_case('unknown_session','unknown-session:'||p_session_id,'paid_session_not_bound_to_any_attempt',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','unknown_session','session_id',p_session_id,'case_id',v_case);
  END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;

  IF p_amount <> v_grp.total_customer_amount THEN
    v_case := _open_case('payment_contradiction','amount:'||p_session_id,'amount_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('expected',v_grp.total_customer_amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF lower(p_currency) <> lower(v_grp.currency) THEN
    v_case := _open_case('payment_contradiction','currency:'||p_session_id,'currency_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.platform_keeps_all THEN
    IF p_connect_dest IS NOT NULL OR p_on_behalf_of IS NOT NULL OR p_application_fee IS NOT NULL
       OR p_transfer_id IS NOT NULL OR p_fee_id IS NOT NULL THEN
      v_case := _open_case('payment_contradiction','connect-on-keepsall:'||p_session_id,'unexpected_connect_fields_on_keeps_all',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_fields','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  ELSE
    v_case := _open_case('payment_contradiction','connected-not-in-pilot:'||p_session_id,'connected_payment_not_in_pilot',
                         v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','connected_not_in_pilot','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] charge-mismatch guard unchanged, but note an authorized group may already carry the
  -- UNCAPTURED charge id from auth time; capture re-delivers the same charge id, so equality holds.
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'group_status',v_grp.status,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  -- [0065] (a) 'authorized' joins the payable set: capture is the second half of a manual-capture payment
  IF v_grp.status NOT IN ('pending','session_created','failed','authorized') THEN
    v_case := _open_case('payment_contradiction','status:'||p_session_id,'group_not_payable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] (c) an 'authorized' attempt is the expected pre-capture state
  IF v_att.status NOT IN ('open','authorized') THEN
    v_case := _open_case('payment_contradiction','attempt-not-open:'||p_session_id,'attempt_not_open',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('attempt_status',v_att.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','attempt_not_open','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  SELECT count(*), coalesce(sum(customer_amount),0) INTO v_alloc_count, v_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
  IF v_alloc_count = 0 OR v_sum <> v_grp.total_customer_amount THEN
    UPDATE payment_groups SET status = 'frozen' WHERE id = v_grp.id;
    v_case := _open_case('frozen_payment','sum:'||p_session_id,'allocation_sum_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'alloc_sum',v_sum,'group_total',v_grp.total_customer_amount));
    RETURN jsonb_build_object('outcome','frozen','reason','allocation_sum_mismatch','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  -- [0065] (b) flippable = normal unpaid checkout OR a held authorization being captured
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id
      AND ((b.payment_status = 'unpaid' AND b.status = 'pending_payment')
        OR (b.payment_status = 'authorized' AND b.status = 'held'));
  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen',
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
           stripe_charge_id = coalesce(stripe_charge_id, p_charge) WHERE id = v_grp.id;
    UPDATE payment_attempts SET status = 'failed', last_error = 'group_frozen_incomplete_apply' WHERE id = v_att.id;
    v_case := _open_case('frozen_payment','frozen:'||p_session_id,'captured_but_not_all_bookings_applyable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'flippable',v_flippable));
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  SELECT coalesce(r.auto_confirm_bookings,false) INTO v_auto FROM retailers r WHERE r.id = v_grp.retailer_id;

  UPDATE payment_groups SET status = 'paid',
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE id = v_att.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  -- [0065] (d) a captured hold re-opens its 'held' outbox row with the real target (demo+emails);
  -- finished non-held rows keep their DO NOTHING replay-idempotency.
  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END, 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO UPDATE
      SET target_status = EXCLUDED.target_status, status = 'pending',
          demo_created = false, emails_sent = false, completed_at = NULL, last_error = NULL,
          -- [0078] C1: the paid work is a NEW generation. The old held lease is invalidated here, in
          -- the same statement, so (a) a capture-side drain can claim the paid work at once and (b)
          -- a worker still holding the held-stage lease can no longer record progress on this row
          -- (complete_fulfillment fences on generation + owner). Attempts restart for the new work.
          generation = booking_fulfillments.generation + 1,
          lease_owner = NULL, lease_expires_at = NULL, attempts = 0
      WHERE booking_fulfillments.target_status = 'held';

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status', CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END);
END $$;
REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. C1 — claim returns the generation; completion is fenced on owner + generation
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_fulfillments(p_owner text, p_lease_seconds integer, p_limit integer, p_group uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb;
BEGIN
  WITH due AS (
    SELECT bf.booking_id FROM booking_fulfillments bf
    WHERE bf.status = 'pending'
      AND (p_group IS NULL OR bf.payment_group_id = p_group)
      AND (bf.lease_expires_at IS NULL OR bf.lease_expires_at < now())
    ORDER BY bf.created_at ASC
    LIMIT greatest(1, coalesce(p_limit,25))
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE booking_fulfillments bf
      SET lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds,120))),
          attempts = bf.attempts + 1
    FROM due WHERE bf.booking_id = due.booking_id
    RETURNING bf.booking_id, bf.payment_group_id, bf.target_status, bf.demo_created, bf.emails_sent, bf.attempts, bf.generation
  )
  SELECT coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) INTO v_rows FROM leased;
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION claim_fulfillments(text,integer,integer,uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_fulfillments(text,integer,integer,uuid) TO service_role;

DROP FUNCTION IF EXISTS complete_fulfillment(uuid, text, boolean, boolean, boolean, text);
CREATE OR REPLACE FUNCTION complete_fulfillment(p_booking_id uuid, p_owner text, p_demo boolean, p_emails boolean, p_done boolean, p_err text, p_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  -- [0078] C1: only the CURRENT generation's lease owner may record progress. A worker that claimed
  -- the held stage and was overtaken by a capture holds a stale (owner, generation) pair: its
  -- completion returns false and changes nothing.
  UPDATE booking_fulfillments
     SET demo_created = demo_created OR coalesce(p_demo,false),
         emails_sent  = emails_sent  OR coalesce(p_emails,false),
         status = CASE WHEN coalesce(p_done,false) THEN 'done' ELSE status END,
         completed_at = CASE WHEN coalesce(p_done,false) THEN now() ELSE completed_at END,
         last_error = coalesce(p_err, last_error),
         lease_owner = NULL, lease_expires_at = NULL
   WHERE booking_id = p_booking_id AND lease_owner = p_owner AND generation = coalesce(p_generation, -1);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION complete_fulfillment(uuid,text,boolean,boolean,boolean,text,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_fulfillment(uuid,text,boolean,boolean,boolean,text,integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. C2 + C3 — booking_transition (0077 body)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_transition(
  p_booking_id uuid, p_retailer_id uuid, p_action text, p_fields jsonb DEFAULT '{}'::jsonb, p_demo_fee numeric DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, status_before text, status_after text, demo_id uuid, demo_created boolean, demo_reactivated boolean, demos_cancelled integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b bookings%ROWTYPE; v_d demos%ROWTYPE; v_target text; v_from text[]; v_cur text; v_fee numeric;
  v_demo_id uuid; v_created boolean := false; v_react boolean := false; v_cancelled integer := 0; v_found boolean;
BEGIN
  IF p_booking_id IS NULL OR p_retailer_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::text, NULL::text, NULL::uuid, false, false, 0; RETURN;
  END IF;
  -- 1. Booking first (the same lock order as accept_reschedule), then its projection.
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id AND b.retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::text, NULL::text, NULL::uuid, false, false, 0; RETURN;
  END IF;
  v_cur := coalesce(v_b.status, 'pending');

  -- 2. Allowed transitions per action, judged on the CURRENT persisted state.
  -- [0078] C2: the action's own terminal target is an ALLOWED current state — a provider-side step
  -- (an authorization release, a capture-side auto-confirm, a concurrent identical request) may have
  -- applied it already. The call then converges: audited fields are applied, the projection is
  -- ensured/retired idempotently, and reason = 'already_applied' (ok = true). Any OTHER state is
  -- still 'state_changed' (ok = false): confirm-vs-cancel and cancel-vs-confirm conflicts keep 409.
  IF p_action = 'confirm' THEN        v_from := ARRAY['pending', 'held', 'confirmed'];              v_target := 'confirmed';
  ELSIF p_action = 'decline' THEN     v_from := ARRAY['pending', 'held', 'declined'];               v_target := 'declined';
  ELSIF p_action = 'cancel' THEN      v_from := ARRAY['pending', 'confirmed', 'held', 'cancelled']; v_target := 'cancelled';
  ELSIF p_action = 'promote_paid' THEN
    v_target := p_fields->>'status';
    IF v_target IS NULL OR v_target NOT IN ('confirmed', 'pending') THEN
      RAISE EXCEPTION 'invalid_target: promote_paid needs status confirmed|pending' USING errcode = 'check_violation';
    END IF;
    v_from := ARRAY['pending_payment', 'held', v_target];   -- the target itself = idempotent retry
    -- [0078] C3: a booking that was legitimately advanced past the job's target (manual confirmation
    -- of a paid pending booking) is 'already_advanced' — not a conflict, never a downgrade. The
    -- caller finishes or supersedes its remaining notification work against the CURRENT state.
    IF v_target = 'pending' AND v_cur = 'confirmed' THEN
      SELECT d.id INTO v_demo_id FROM demos d WHERE d.booking_id = p_booking_id AND coalesce(d.status, '') IN ('confirmed', 'scheduled', 'completed') ORDER BY d.created_at LIMIT 1;
      RETURN QUERY SELECT false, 'already_advanced'::text, v_cur, v_cur, v_demo_id, false, false, 0;
      RETURN;
    END IF;
  ELSIF p_action = 'materialize' THEN v_from := ARRAY['confirmed'];                    v_target := 'confirmed';
  ELSE
    RAISE EXCEPTION 'invalid_action: %', p_action USING errcode = 'check_violation';
  END IF;

  IF NOT (v_cur = ANY (v_from)) THEN
    RETURN QUERY SELECT false,
      CASE WHEN v_cur IN ('cancelled', 'declined', 'expired', 'auth_canceled') AND p_action IN ('promote_paid', 'materialize') THEN 'superseded' ELSE 'state_changed' END,
      v_cur, v_cur, NULL::uuid, false, false, 0;
    RETURN;
  END IF;

  -- 3. The booking transition (+ the caller's audited fields). UPDATE OF status fires the offering
  --    re-check only for inactive -> active (none of these), never for active -> active.
  IF v_cur <> v_target OR p_fields <> '{}'::jsonb THEN
    UPDATE bookings SET
      status            = v_target,
      cancelled_at      = CASE WHEN p_fields ? 'cancelled_at'      THEN (p_fields->>'cancelled_at')::timestamptz ELSE cancelled_at END,
      cancel_reason     = CASE WHEN p_fields ? 'cancel_reason'     THEN p_fields->>'cancel_reason'                ELSE cancel_reason END,
      refund_id         = CASE WHEN p_fields ? 'refund_id'         THEN p_fields->>'refund_id'                    ELSE refund_id END,
      payment_status    = CASE WHEN p_fields ? 'payment_status'    THEN p_fields->>'payment_status'               ELSE payment_status END,
      payment_intent_id = CASE WHEN p_fields ? 'payment_intent_id' THEN p_fields->>'payment_intent_id'            ELSE payment_intent_id END,
      paid_at           = CASE WHEN p_fields ? 'paid_at'           THEN (p_fields->>'paid_at')::timestamptz       ELSE paid_at END
    WHERE id = p_booking_id
    RETURNING * INTO v_b;
  END IF;

  -- 4. The projection, under the same lock. At most one demo per booking (demos_one_per_booking).
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  v_found := FOUND;
  IF v_target = 'confirmed' THEN
    IF v_b.demo_date IS NULL THEN
      RAISE EXCEPTION 'booking_has_no_date: % cannot be projected onto the calendar', p_booking_id USING errcode = 'check_violation';
    END IF;
    v_fee := p_demo_fee;
    IF v_fee IS NULL THEN SELECT x.demo_fee INTO v_fee FROM venues x WHERE x.id = v_b.venue_id; END IF;
    IF v_found AND coalesce(v_d.status, '') IN ('confirmed', 'scheduled', 'completed') THEN
      v_demo_id := v_d.id;
    ELSIF v_found THEN
      -- a retired projection for a booking that is confirmed again: bring it back on the current schedule
      UPDATE demos SET status = 'confirmed', confirmed_at = now(),
             venue_id = v_b.venue_id, demo_date = v_b.demo_date, demo_time = v_b.demo_time,
             duration_hours = coalesce(v_b.duration_hours, demos.duration_hours, 3),
             demo_fee = coalesce(v_fee, demos.demo_fee)
       WHERE id = v_d.id;
      v_demo_id := v_d.id; v_react := true;
    ELSE
      INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, contact_phone, product, product_skus,
                         demo_date, demo_time, duration_hours, status, confirmed_at, demo_fee, notes, booking_id)
      VALUES (v_b.retailer_id, v_b.venue_id, v_b.brand_id, coalesce(nullif(btrim(v_b.brand_name), ''), 'Unknown'), v_b.contact_name, v_b.contact_email, v_b.contact_phone,
              v_b.product, CASE WHEN jsonb_typeof(v_b.product_skus) = 'array' AND jsonb_array_length(v_b.product_skus) > 0 THEN v_b.product_skus ELSE NULL END,
              v_b.demo_date, v_b.demo_time, coalesce(v_b.duration_hours, 3), 'confirmed', now(), v_fee, v_b.notes, v_b.id)
      RETURNING id INTO v_demo_id;
      v_created := true;
    END IF;
  ELSIF v_target IN ('cancelled', 'declined') THEN
    UPDATE demos SET status = 'cancelled'
     WHERE booking_id = p_booking_id AND coalesce(status, '') IN ('confirmed', 'scheduled');
    GET DIAGNOSTICS v_cancelled = ROW_COUNT;
    IF v_found THEN v_demo_id := v_d.id; END IF;
  ELSE
    IF v_found THEN v_demo_id := v_d.id; END IF;
  END IF;

  RETURN QUERY SELECT true, CASE WHEN v_cur = v_target AND p_action IN ('confirm', 'decline', 'cancel') THEN 'already_applied'::text ELSE NULL::text END,
                      v_cur, v_target, v_demo_id, v_created, v_react, v_cancelled;
END $$;
REVOKE ALL ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. C1 — projection_anomalies (0077 body + stranded-payment branches)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.projection_anomalies(p_retailer_id uuid DEFAULT NULL)
RETURNS TABLE(booking_id uuid, demo_id uuid, retailer_id uuid, booking_status text, demo_status text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, d.id, b.retailer_id, b.status, d.status, 'active_demo_for_inactive_booking'
    FROM bookings b JOIN demos d ON d.booking_id = b.id
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND coalesce(b.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled')
     AND coalesce(d.status, '') IN ('confirmed', 'scheduled')
  UNION ALL
  SELECT b.id, NULL::uuid, b.retailer_id, b.status, NULL::text, 'confirmed_booking_without_demo'
    FROM bookings b
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND b.status = 'confirmed' AND b.demo_date >= current_date
     AND NOT EXISTS (SELECT 1 FROM demos d WHERE d.booking_id = b.id AND coalesce(d.status, '') IN ('confirmed', 'scheduled', 'completed'))
  UNION ALL
  -- [0078] C1: a captured (paid) booking must leave held/pending_payment through the outbox. A short
  -- in-flight interval is legitimate; past it the booking is stranded (lost or wrongly-terminal work).
  SELECT b.id, NULL::uuid, b.retailer_id, b.status, NULL::text, 'paid_booking_not_promoted'
    FROM bookings b
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND b.payment_status = 'paid' AND coalesce(b.status, '') IN ('held', 'pending_payment')
     AND coalesce(b.paid_at, b.created_at) < now() - interval '15 minutes'
  UNION ALL
  -- [0078] C1: an outbox row recorded as done for paid work while the booking never left held /
  -- pending_payment (the old-worker case) — immediate, no grace interval.
  SELECT b.id, NULL::uuid, b.retailer_id, b.status, NULL::text, 'fulfillment_done_but_booking_not_promoted'
    FROM bookings b JOIN booking_fulfillments f ON f.booking_id = b.id
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND f.status = 'done' AND f.target_status IN ('pending', 'confirmed')
     AND coalesce(b.status, '') IN ('held', 'pending_payment')
  ORDER BY 1
$$;
REVOKE ALL ON FUNCTION public.projection_anomalies(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.projection_anomalies(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Post-conditions (literal-only; no fixture rows)
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_fulfillments' AND column_name = 'generation') THEN
    RAISE EXCEPTION '0078 postcondition: booking_fulfillments.generation missing';
  END IF;
  IF to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text,integer)') IS NULL THEN
    RAISE EXCEPTION '0078 postcondition: 7-argument complete_fulfillment missing';
  END IF;
  IF to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)') IS NOT NULL THEN
    RAISE EXCEPTION '0078 postcondition: 6-argument complete_fulfillment must be gone (cutover fence)';
  END IF;
  IF position('bf.generation' IN pg_get_functiondef('public.claim_fulfillments(text,integer,integer,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0078 postcondition: claim_fulfillments does not return the generation';
  END IF;
  IF position('generation = booking_fulfillments.generation + 1' IN pg_get_functiondef('public.apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0078 postcondition: apply_verified_payment does not start a new generation';
  END IF;
  IF position('already_advanced' IN pg_get_functiondef('public.booking_transition(uuid,uuid,text,jsonb,numeric)'::regprocedure)) = 0
     OR position('already_applied' IN pg_get_functiondef('public.booking_transition(uuid,uuid,text,jsonb,numeric)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0078 postcondition: booking_transition lacks the C2/C3 outcomes';
  END IF;
  IF position('paid_booking_not_promoted' IN pg_get_functiondef('public.projection_anomalies(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0078 postcondition: projection_anomalies lacks the stranded-payment branch';
  END IF;
  -- a stale completion (unknown generation) must be refused without touching anything
  IF complete_fulfillment('00000000-0000-4000-8000-000000000000'::uuid, 'nobody', true, true, true, NULL, 0) THEN
    RAISE EXCEPTION '0078 postcondition: a stale completion was accepted';
  END IF;
END $$;
