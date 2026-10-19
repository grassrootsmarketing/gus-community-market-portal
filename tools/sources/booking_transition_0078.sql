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
