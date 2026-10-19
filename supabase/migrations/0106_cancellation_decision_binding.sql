-- 0106_cancellation_decision_binding.sql (2026-10-19, Codex refund-cutoff revision 2 review, R2-2 and R2-3)
-- 0104 and 0105 are applied to the test project and are left byte-for-byte; every correction is forward, here.
--
-- R2-3  The recorded cancellation decision is bound to the authoritative row and becomes a barrier:
--   * booking_cancellation_record(booking, retailer, decision, expect) records only if, under the booking's lock, the
--     row still shows the schedule revision, date, time, payment status, fee waiver and the store's mode and zone the
--     decision was computed from; otherwise it answers 'stale' with the current values and writes nothing. The route
--     recomputes once from the current row and records again. A retry replays the saved decision ('existing').
--   * bookings.cancellation_pending_at is set in that same statement. While set, booking_transition refuses every
--     action but 'cancel' ('cancellation_pending'), and the three schedule changes (move_booking_by_retailer,
--     propose_reschedule, accept_reschedule) refuse the same way, next to the existing move-settlement barrier.
--     booking_transition('cancel') clears it. No database transaction is held across any Stripe call.
-- R2-2  A cancelled paid booking whose refund was left undecided gets an operator resolution, recorded once:
--   * booking_cancellation_resolutions (one per booking): refund_granted | no_refund, who, why, when, the refund
--     request and the review case it closed. booking_cancellation_resolve() inserts once and replays on retry; the
--     initial decision row in booking_cancellations is never changed.
-- Grants: every function here is EXECUTE for service_role explicitly; public, anon and authenticated are denied.
-- Forward-only. Idempotent. No row rewrites. No begin/commit here: the production paste wraps it.

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS cancellation_pending_at timestamptz;
CREATE INDEX IF NOT EXISTS bookings_cancellation_pending ON public.bookings (cancellation_pending_at) WHERE cancellation_pending_at IS NOT NULL;
COMMENT ON COLUMN public.bookings.cancellation_pending_at IS '0106: a cancellation decision is recorded and the cancellation is landing; no confirmation, capture promotion or schedule change may run until booking_transition(cancel) clears it.';

CREATE TABLE IF NOT EXISTS public.booking_cancellation_resolutions (
  booking_id          uuid PRIMARY KEY REFERENCES public.bookings(id) ON DELETE CASCADE,
  retailer_id         uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
  decision            text NOT NULL CHECK (decision IN ('refund_granted', 'no_refund')),
  operator            text,
  reason              text NOT NULL,
  refund_request_id   uuid,
  case_id             uuid,
  resolved_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.booking_cancellation_resolutions FROM public, anon, authenticated;
GRANT ALL ON TABLE public.booking_cancellation_resolutions TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_cancellation_record, bound to the authoritative row (replaces the 0105 three-argument form).
-- p_expect: {schedule_revision, demo_date, demo_time, payment_status, fee_waived, cancellation_mode, timezone}.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.booking_cancellation_record(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.booking_cancellation_record(p_booking_id uuid, p_retailer_id uuid, p_decision jsonb, p_expect jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk public.bookings%ROWTYPE; v_rt record; v_row public.booking_cancellations%ROWTYPE; v_now timestamptz; v_current jsonb;
BEGIN
  SELECT * INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM public.booking_cancellations WHERE booking_id = p_booking_id;
  IF FOUND THEN
    -- a retry continues the recorded operation; the barrier is (re)asserted while the booking is still active
    IF v_bk.status IN ('pending', 'confirmed', 'held') AND v_bk.cancellation_pending_at IS NULL THEN
      UPDATE public.bookings SET cancellation_pending_at = v_now WHERE id = p_booking_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'existing', 'existing', true, 'decision', to_jsonb(v_row));
  END IF;
  IF v_bk.status NOT IN ('pending', 'confirmed', 'held') THEN
    RETURN jsonb_build_object('outcome', 'state_conflict', 'status', v_bk.status);
  END IF;
  SELECT cancellation_mode, timezone INTO v_rt FROM public.retailers WHERE id = p_retailer_id;
  v_current := jsonb_build_object(
    'schedule_revision', v_bk.schedule_revision, 'demo_date', v_bk.demo_date, 'demo_time', v_bk.demo_time,
    'payment_status', v_bk.payment_status, 'fee_waived', coalesce(v_bk.fee_waived, false),
    'cancellation_mode', v_rt.cancellation_mode, 'timezone', v_rt.timezone, 'status', v_bk.status);
  -- the decision was computed from these inputs; if the row moved on, it is not recorded
  IF p_expect IS NOT NULL THEN
    IF (p_expect ? 'schedule_revision' AND (p_expect->>'schedule_revision')::integer IS DISTINCT FROM v_bk.schedule_revision)
       OR (p_expect ? 'demo_date' AND (p_expect->>'demo_date')::date IS DISTINCT FROM v_bk.demo_date)
       OR (p_expect ? 'demo_time' AND (p_expect->>'demo_time') IS DISTINCT FROM v_bk.demo_time)
       OR (p_expect ? 'payment_status' AND (p_expect->>'payment_status') IS DISTINCT FROM v_bk.payment_status)
       OR (p_expect ? 'fee_waived' AND (p_expect->>'fee_waived')::boolean IS DISTINCT FROM coalesce(v_bk.fee_waived, false))
       OR (p_expect ? 'cancellation_mode' AND (p_expect->>'cancellation_mode') IS DISTINCT FROM v_rt.cancellation_mode)
       OR (p_expect ? 'timezone' AND (p_expect->>'timezone') IS DISTINCT FROM v_rt.timezone) THEN
      RETURN jsonb_build_object('outcome', 'stale', 'current', v_current);
    END IF;
  END IF;
  INSERT INTO public.booking_cancellations (booking_id, retailer_id, category, requested_at, actor, cancellation_mode, cutoff_hours,
      start_at, start_source, hours_before_demo, refund, status, reason, force_refund, override_reason, backdate_note, note)
  VALUES (p_booking_id, p_retailer_id, p_decision->>'category', (p_decision->>'requested_at')::timestamptz, p_decision->>'actor',
      p_decision->>'cancellation_mode', (p_decision->>'cutoff_hours')::integer,
      NULLIF(p_decision->>'start_at', '')::timestamptz, p_decision->>'start_source', NULLIF(p_decision->>'hours_before_demo', '')::numeric,
      (p_decision->>'refund')::boolean, p_decision->>'status', p_decision->>'reason', coalesce((p_decision->>'force_refund')::boolean, false),
      p_decision->>'override_reason', p_decision->>'backdate_note', p_decision->>'note')
  RETURNING * INTO v_row;
  UPDATE public.bookings SET cancellation_pending_at = v_now WHERE id = p_booking_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'existing', false, 'decision', to_jsonb(v_row), 'current', v_current);
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_record(uuid, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_record(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_cancellation_resolve: the operator's later answer, once per booking, replayed on retry.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_resolve(p_booking_id uuid, p_retailer_id uuid, p_decision text, p_operator text, p_reason text, p_refund_request_id uuid DEFAULT NULL, p_case_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_dec public.booking_cancellations%ROWTYPE; v_res public.booking_cancellation_resolutions%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('refund_granted', 'no_refund') THEN RETURN jsonb_build_object('outcome', 'invalid_decision'); END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RETURN jsonb_build_object('outcome', 'reason_required'); END IF;
  SELECT id, retailer_id, status, payment_status INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'existing', 'existing', true, 'resolution', to_jsonb(v_res)); END IF;
  IF v_bk.status NOT IN ('cancelled', 'declined') THEN RETURN jsonb_build_object('outcome', 'not_cancelled', 'status', v_bk.status); END IF;
  SELECT * INTO v_dec FROM public.booking_cancellations WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_decision'); END IF;
  IF v_dec.refund = true THEN RETURN jsonb_build_object('outcome', 'already_refunding', 'decision', to_jsonb(v_dec)); END IF;
  INSERT INTO public.booking_cancellation_resolutions (booking_id, retailer_id, decision, operator, reason, refund_request_id, case_id)
  VALUES (p_booking_id, p_retailer_id, p_decision, p_operator, left(btrim(p_reason), 500), p_refund_request_id, p_case_id)
  RETURNING * INTO v_res;
  RETURN jsonb_build_object('outcome', 'resolved', 'existing', false, 'resolution', to_jsonb(v_res), 'decision', to_jsonb(v_dec));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_transition (0078 body + the 0106 barrier; verbatim otherwise).
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

  -- 0106 (Codex refund-cutoff R2-3): a recorded cancellation decision is a barrier until the cancellation lands.
  -- No confirmation, capture promotion or projection step may run on top of it; only the cancel itself.
  IF v_b.cancellation_pending_at IS NOT NULL AND p_action <> 'cancel' THEN
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_cur, v_cur, NULL::uuid, false, false, 0; RETURN;
  END IF;

  -- 2. Allowed transitions per action, judged on the CURRENT persisted state.
  -- [0078] C2: the action's own terminal target is an ALLOWED current state , a provider-side step
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
    -- of a paid pending booking) is 'already_advanced' , not a conflict, never a downgrade. The
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
      paid_at           = CASE WHEN p_fields ? 'paid_at'           THEN (p_fields->>'paid_at')::timestamptz       ELSE paid_at END,
      cancellation_pending_at = CASE WHEN p_action = 'cancel' THEN NULL ELSE cancellation_pending_at END   -- 0106: the barrier lifts with the cancellation
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
-- move_booking_by_retailer, propose_reschedule, accept_reschedule (0095 bodies + the 0106 barrier; verbatim otherwise).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_booking_by_retailer(
  p_demo_id uuid, p_retailer_id uuid, p_new_date date, p_new_time text DEFAULT NULL,
  p_note text DEFAULT NULL, p_actor text DEFAULT NULL, p_reconfirm_hours integer DEFAULT 72)
RETURNS TABLE(ok boolean, reason text, booking_id uuid, schedule_revision integer, move_id uuid, reconfirm_due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid      uuid;
  v_b        bookings%ROWTYPE;
  v_d        demos%ROWTYPE;
  v_brand    brands%ROWTYPE;
  v_tz       text;
  v_today    date;
  v_new_time text;
  v_old_rev  integer;
  v_new_rev  integer;
  v_new_dur  integer;
  v_start    timestamptz;
  v_covered  boolean;
  v_note     text;
  v_due      timestamptz;
  v_move     uuid;
  v_hours    integer := greatest(coalesce(p_reconfirm_hours, 72), 1);
BEGIN
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND OR v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'not_active'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  -- RM-1: a decline / lapse is being settled (cancel + refund). No schedule change may land on top of it.
  IF v_b.pending_move_settlement IS NOT NULL OR v_b.cancellation_pending_at IS NOT NULL THEN   -- 0106: a recorded cancellation is a barrier too
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_bid, v_b.schedule_revision, v_b.pending_move_settlement, NULL::timestamptz; RETURN;
  END IF;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF length(coalesce(v_note, '')) > 500 THEN RETURN QUERY SELECT false, 'note_too_long'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_new_date IS NULL OR p_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  v_new_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);
  IF p_new_date = v_b.demo_date AND (
       v_new_time IS NOT DISTINCT FROM v_b.demo_time
       OR (booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT NULL
           AND booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT DISTINCT FROM booking_slot_start(v_b.demo_date, v_b.demo_time, v_tz, NULL))) THEN
    RETURN QUERY SELECT false, 'same_slot'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_brand FROM brands br WHERE br.id = coalesce(v_b.brand_id, v_d.brand_id);
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= p_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = p_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = v_bid
    RETURNING bookings.schedule_revision, bookings.duration_hours, bookings.start_at INTO v_new_rev, v_new_dur, v_start;
    IF v_start IS NULL THEN
      RAISE EXCEPTION 'unresolvable_start' USING errcode = 'check_violation';
    END IF;
    IF v_start <= now() THEN
      RAISE EXCEPTION 'time_in_past' USING errcode = 'check_violation';
    END IF;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_not_offered%' THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_outside_hours%' THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'date_blackout%' THEN RETURN QUERY SELECT false, 'date_blackout'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'venue_closed%' THEN RETURN QUERY SELECT false, 'venue_closed'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_config_invalid%' THEN RETURN QUERY SELECT false, 'slot_config_invalid'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'venue_hours_not_set%' THEN RETURN QUERY SELECT false, 'venue_hours_not_set'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'invalid_local_time%' THEN RETURN QUERY SELECT false, 'invalid_local_time'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'time_in_past%' THEN RETURN QUERY SELECT false, 'time_in_past'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'unresolvable_start%' THEN RETURN QUERY SELECT false, 'unresolvable_start'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    RAISE;
  END;

  UPDATE demos
     SET demo_date = p_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- RM-5: ONE explicit policy, the same function the store sees before committing.
  v_due := move_reconfirm_deadline(now(), v_start, v_hours);

  UPDATE booking_moves SET status = 'superseded', updated_at = now()
   WHERE booking_moves.booking_id = v_bid AND booking_moves.status = 'pending';
  INSERT INTO booking_moves (booking_id, retailer_id, brand_id, demo_id, from_date, from_time, to_date, to_time, schedule_revision, note, moved_by, moved_at, reconfirm_due_at)
  VALUES (v_bid, p_retailer_id, coalesce(v_b.brand_id, v_d.brand_id), v_d.id, v_b.demo_date, v_b.demo_time, p_new_date, v_new_time, v_new_rev, v_note, p_actor, now(), v_due)
  RETURNING id INTO v_move;

  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, v_bid, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          v_bid::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', p_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'moved_by_retailer', true, 'move_id', v_move))
  ON CONFLICT (kind, transition_id) DO NOTHING;
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, v_bid, coalesce(v_b.brand_id, v_d.brand_id), 'demo_moved', v_move::text,
          jsonb_build_object('move_id', v_move, 'old_date', v_b.demo_date, 'old_time', v_b.demo_time,
                             'new_date', p_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'note', v_note, 'reconfirm_due_at', v_due, 'venue_id', v_b.venue_id, 'timezone', v_tz))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = v_bid::text || ':' || v_old_rev::text
     AND notification_deliveries.status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_bid, v_new_rev, v_move, v_due;
END $$;
REVOKE ALL ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.propose_reschedule(p_demo_id uuid, p_retailer_id uuid, p_new_date date, p_new_time text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, proposal_version integer, booking_id uuid, new_time text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid  uuid;
  v_b    bookings%ROWTYPE;
  v_d    demos%ROWTYPE;
  v_tz   text;
  v_ver  integer;
  v_time text;
BEGIN
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;

  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid OR v_d.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') OR coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') THEN
    RETURN QUERY SELECT false, 'not_active'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;
  -- RM-1 (0095): no schedule change while a declined / lapsed move is being settled.
  IF v_b.pending_move_settlement IS NOT NULL OR v_b.cancellation_pending_at IS NOT NULL THEN   -- 0106: a recorded cancellation is a barrier too
    RETURN QUERY SELECT false, 'cancellation_pending'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  IF p_new_date IS NULL OR p_new_date < (now() AT TIME ZONE coalesce(nullif(v_tz, ''), 'America/Los_Angeles'))::date THEN
    RETURN QUERY SELECT false, 'date_in_past'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;
  v_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);

  UPDATE demos
     SET reschedule_to_date = p_new_date, reschedule_to_time = v_time, reschedule_requested_at = now()
   WHERE id = p_demo_id;
  UPDATE bookings
     SET reschedule_proposal_version = reschedule_proposal_version + 1
   WHERE id = v_bid
  RETURNING reschedule_proposal_version INTO v_ver;

  RETURN QUERY SELECT true, NULL::text, v_ver, v_bid, v_time;
END $$;
REVOKE ALL ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) TO service_role;

CREATE OR REPLACE FUNCTION public.accept_reschedule(p_booking_id uuid, p_brand_id uuid, p_proposal_version integer)
RETURNS TABLE(ok boolean, reason text, schedule_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b        bookings%ROWTYPE;
  v_d        demos%ROWTYPE;
  v_brand    brands%ROWTYPE;
  v_tz       text;
  v_today    date;
  v_new_date date;
  v_new_time text;
  v_old_rev  integer;
  v_new_rev  integer;
  v_new_dur  integer;
  v_covered  boolean;
BEGIN
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_demo'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_d.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_b.schedule_revision; RETURN;
  END IF;
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'cancelled'::text, v_b.schedule_revision; RETURN;
  END IF;
  -- RM-1 (0095): no schedule change while a declined / lapsed move is being settled.
  IF v_b.pending_move_settlement IS NOT NULL OR v_b.cancellation_pending_at IS NOT NULL THEN   -- 0106: a recorded cancellation is a barrier too
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_b.schedule_revision; RETURN;
  END IF;
  IF v_d.reschedule_to_date IS NULL THEN RETURN QUERY SELECT false, 'no_proposal'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_proposal_version IS NULL OR v_b.reschedule_proposal_version <> p_proposal_version THEN
    RETURN QUERY SELECT false, 'stale_proposal'::text, v_b.schedule_revision; RETURN;
  END IF;

  v_new_date := v_d.reschedule_to_date;
  v_new_time := coalesce(nullif(btrim(v_d.reschedule_to_time), ''), v_b.demo_time, v_d.demo_time);

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = v_b.retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF v_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_b.schedule_revision; RETURN; END IF;

  SELECT * INTO v_brand FROM brands br WHERE br.id = p_brand_id;
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= v_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_b.schedule_revision; RETURN; END IF;

  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = v_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = p_booking_id
    RETURNING bookings.schedule_revision, bookings.duration_hours INTO v_new_rev, v_new_dur;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_not_offered%' THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_outside_hours%' THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'date_blackout%' THEN RETURN QUERY SELECT false, 'date_blackout'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'venue_closed%' THEN RETURN QUERY SELECT false, 'venue_closed'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_config_invalid%' THEN RETURN QUERY SELECT false, 'slot_config_invalid'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'venue_hours_not_set%' THEN RETURN QUERY SELECT false, 'venue_hours_not_set'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'invalid_local_time%' THEN RETURN QUERY SELECT false, 'invalid_local_time'::text, v_old_rev; RETURN; END IF;
    RAISE;
  END;

  UPDATE demos
     SET demo_date = v_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- RM-1 (0095): a valid newer schedule retires any unanswered retailer move atomically.
  UPDATE booking_moves SET status = 'superseded', updated_at = now()
   WHERE booking_moves.booking_id = p_booking_id AND booking_moves.status = 'pending';

  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, p_booking_id, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          p_booking_id::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', v_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'proposal_version', p_proposal_version))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = p_booking_id::text || ':' || v_old_rev::text
     AND status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_new_rev;
END $$;
REVOKE ALL ON FUNCTION public.accept_reschedule(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(uuid, uuid, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'cancellation_pending_at') THEN RAISE EXCEPTION '0106 postcondition: bookings.cancellation_pending_at missing'; END IF;
  IF to_regclass('public.booking_cancellation_resolutions') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_resolutions missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_record (4 args) missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb)') IS NOT NULL THEN RAISE EXCEPTION '0106 postcondition: the 0105 three-argument record function still exists'; END IF;
  IF to_regprocedure('public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid)') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_resolve missing'; END IF;
  SELECT pg_get_functiondef('public.booking_transition(uuid, uuid, text, jsonb, numeric)'::regprocedure) INTO v_def;
  IF position('cancellation_pending' IN v_def) = 0 THEN RAISE EXCEPTION '0106 postcondition: booking_transition lacks the barrier'; END IF;
  FOREACH v_def IN ARRAY ARRAY['public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)', 'public.propose_reschedule(uuid, uuid, date, text)', 'public.accept_reschedule(uuid, uuid, integer)'] LOOP
    IF position('cancellation_pending_at' IN pg_get_functiondef(v_def::regprocedure)) = 0 THEN RAISE EXCEPTION '0106 postcondition: % lacks the barrier', v_def; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '0106 postcondition: service_role cannot execute booking_cancellation_record'; END IF;
  IF has_function_privilege('anon', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '0106 postcondition: anon can execute booking_cancellation_record'; END IF;
END $$;
