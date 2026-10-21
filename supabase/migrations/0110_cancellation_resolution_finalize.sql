-- 0110_cancellation_resolution_finalize.sql (2026-10-20, Codex refund-cutoff revision 6 review, R6-1 / R6-2)
-- Forward-only: 0106 to 0109 are applied to the test project and are left byte for byte.
--
-- R6-1  Completion is ONE shared, idempotent rule (_cancellation_resolution_finalize) used by every progress mark, by
--       the relink, and by an explicit 'finalize' mark the resume path always calls: a grant needs a linked request
--       whose REAL state is submitted, pending or succeeded and a submitted mark; a denial needs no refund; the case
--       closure and the outbox handoff marks must exist; only then the row is completed, its escalation is cleared
--       and the booking's escalation cases are resolved. Nothing is fabricated to reach completion.
-- R6-2  A recovery budget per generation: attempts stays the lifetime audit count; attempts_baseline records the
--       count at the last authorized recovery transition (a validated relink) and recovery_generation counts them.
--       The worker applies the cap to attempts minus attempts_baseline, so an authorized replacement restores a full
--       budget without erasing history; an arbitrary replay never resets it (only the relink writes the baseline).
-- Grants: service_role EXECUTE explicitly; public, anon and authenticated denied. Idempotent. No begin/commit here.

ALTER TABLE public.booking_cancellation_resolutions
  ADD COLUMN IF NOT EXISTS attempts_baseline integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_generation integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------------------------
-- The shared completion rule. Internal (no grants beyond service_role); called under the booking's lock by its callers.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._cancellation_resolution_finalize(p_booking_id uuid)
RETURNS public.booking_cancellation_resolutions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res public.booking_cancellation_resolutions%ROWTYPE; v_rq_status text; v_money_done boolean;
BEGIN
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF NOT FOUND OR v_res.state = 'completed' THEN RETURN v_res; END IF;
  IF v_res.decision = 'no_refund' THEN
    v_money_done := true;
  ELSE
    v_money_done := false;
    IF v_res.refund_request_id IS NOT NULL AND v_res.refund_submitted_at IS NOT NULL THEN
      SELECT rq.status INTO v_rq_status FROM public.refund_requests rq WHERE rq.id = v_res.refund_request_id;
      v_money_done := v_rq_status IN ('submitted', 'pending', 'succeeded');
    END IF;
  END IF;
  IF v_money_done AND v_res.case_closed_at IS NOT NULL AND v_res.brand_notified_at IS NOT NULL THEN
    UPDATE public.booking_cancellation_resolutions
       SET state = 'completed', escalation_cleared_at = CASE WHEN escalated_at IS NOT NULL THEN coalesce(escalation_cleared_at, now()) ELSE escalation_cleared_at END, last_error = NULL, updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    UPDATE public.reconciliation_cases SET status = 'resolved', resolved_by = coalesce(v_res.operator, 'refund-review'), resolved_at = now()
     WHERE (id = v_res.escalated_case_id OR dedupe_key = 'resolution-failed:' || p_booking_id::text) AND status <> 'resolved';
  END IF;
  RETURN v_res;
END $$;
REVOKE ALL ON FUNCTION public._cancellation_resolution_finalize(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cancellation_resolution_finalize(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- Relink (0109 body) + the new recovery budget + the shared finalization.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_relink(p_booking_id uuid, p_retailer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_res public.booking_cancellation_resolutions%ROWTYPE; v_old record; v_new record; v_grp_retailer uuid; v_submitted boolean;
BEGIN
  SELECT id, retailer_id INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_resolution'); END IF;
  IF v_res.decision <> 'refund_granted' OR v_res.refund_request_id IS NULL THEN RETURN jsonb_build_object('outcome', 'not_linked', 'resolution', to_jsonb(v_res)); END IF;
  IF v_res.state = 'completed' THEN RETURN jsonb_build_object('outcome', 'completed', 'resolution', to_jsonb(v_res)); END IF;
  SELECT rq.id, rq.status, rq.parent_operation_id, rq.payment_allocation_id, rq.booking_id, rq.attempt_version INTO v_old FROM public.refund_requests rq WHERE rq.id = v_res.refund_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'linked_request_missing'); END IF;
  IF v_old.status <> 'superseded' THEN RETURN jsonb_build_object('outcome', 'not_superseded', 'request_status', v_old.status, 'resolution', to_jsonb(v_res)); END IF;
  SELECT rq.id, rq.status, rq.attempt_version INTO v_new
    FROM public.refund_requests rq
   WHERE rq.parent_operation_id = v_old.parent_operation_id
     AND rq.booking_id = p_booking_id
     AND rq.payment_allocation_id = v_old.payment_allocation_id
     AND rq.attempt_version > v_old.attempt_version
     AND rq.status NOT IN ('superseded', 'canceled')
     AND EXISTS (SELECT 1 FROM public.refund_review_actions ra WHERE ra.refund_request_id = rq.id AND ra.action = 'replace' AND ra.retailer_id = p_retailer_id)
   ORDER BY rq.attempt_version DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_successor', 'resolution', to_jsonb(v_res)); END IF;
  SELECT g.retailer_id INTO v_grp_retailer FROM public.payment_allocations a JOIN public.payment_groups g ON g.id = a.payment_group_id WHERE a.id = v_old.payment_allocation_id;
  IF v_grp_retailer IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  v_submitted := v_new.status IN ('submitted', 'pending', 'succeeded');
  UPDATE public.booking_cancellation_resolutions
     SET refund_request_id = v_new.id,
         refund_submitted_at = CASE WHEN v_submitted THEN now() ELSE NULL END,
         state = CASE WHEN v_submitted THEN 'refund_submitted' ELSE 'refund_pending' END,
         escalation_cleared_at = CASE WHEN escalated_at IS NOT NULL THEN now() ELSE escalation_cleared_at END,
         attempts_baseline = attempts, recovery_generation = recovery_generation + 1,   -- R6-2: a validated replacement restores the budget
         last_error = NULL, updated_at = now()
   WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  v_res := public._cancellation_resolution_finalize(p_booking_id);   -- R6-1: completes at once when nothing else is owed
  RETURN jsonb_build_object('outcome', 'relinked', 'previous_request_id', v_old.id, 'request_id', v_new.id, 'request_status', v_new.status, 'attempt_version', v_new.attempt_version, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_relink(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_relink(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- Progress marks (0109 body) + the explicit 'finalize' mark + the shared finalization.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_progress(p_booking_id uuid, p_retailer_id uuid, p_mark text, p_refund_request_id uuid DEFAULT NULL, p_error text DEFAULT NULL, p_case_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_res public.booking_cancellation_resolutions%ROWTYPE; v_rq record; v_grp_retailer uuid; v_closed integer := 0; v_event uuid; v_dec record;
BEGIN
  SELECT id, retailer_id, brand_id INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_resolution'); END IF;
  IF p_mark IN ('refund_submitted', 'refund_pending') THEN
    IF v_res.decision <> 'refund_granted' THEN RETURN jsonb_build_object('outcome', 'not_a_grant', 'resolution', to_jsonb(v_res)); END IF;
    IF p_refund_request_id IS NULL THEN RETURN jsonb_build_object('outcome', 'refund_request_required'); END IF;
    SELECT rq.id, rq.booking_id, rq.payment_allocation_id, rq.status INTO v_rq FROM public.refund_requests rq WHERE rq.id = p_refund_request_id;
    IF NOT FOUND OR v_rq.booking_id IS DISTINCT FROM p_booking_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch'); END IF;
    SELECT g.retailer_id INTO v_grp_retailer FROM public.payment_allocations a JOIN public.payment_groups g ON g.id = a.payment_group_id WHERE a.id = v_rq.payment_allocation_id;
    IF v_grp_retailer IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch'); END IF;
    IF v_res.refund_request_id IS NOT NULL AND v_res.refund_request_id <> p_refund_request_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch', 'resolution', to_jsonb(v_res)); END IF;
    IF v_rq.status IN ('requires_review', 'failed', 'failed_terminal', 'canceled', 'superseded') THEN
      RETURN jsonb_build_object('outcome', 'refund_request_terminal', 'request_status', v_rq.status, 'resolution', to_jsonb(v_res));
    END IF;
    IF p_mark = 'refund_submitted' AND v_rq.status NOT IN ('submitted', 'pending', 'succeeded') THEN
      RETURN jsonb_build_object('outcome', 'refund_request_not_submitted', 'request_status', v_rq.status, 'resolution', to_jsonb(v_res));
    END IF;
    UPDATE public.booking_cancellation_resolutions
       SET refund_request_id = p_refund_request_id,
           refund_submitted_at = CASE WHEN p_mark = 'refund_submitted' THEN coalesce(refund_submitted_at, now()) ELSE refund_submitted_at END,
           state = CASE WHEN state = 'completed' THEN state ELSE p_mark END, last_error = NULL, updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'case_closed' THEN
    UPDATE public.reconciliation_cases SET status = 'resolved', resolved_by = coalesce(v_res.operator, 'refund-review'), resolved_at = now()
     WHERE dedupe_key = 'refund-eligibility:' || p_booking_id::text AND status <> 'resolved';
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    UPDATE public.booking_cancellation_resolutions SET case_closed_at = coalesce(case_closed_at, now()), updated_at = now(), last_error = NULL WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'brand_notified' THEN
    SELECT * INTO v_dec FROM public.booking_cancellations WHERE booking_id = p_booking_id;
    INSERT INTO public.notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (v_bk.retailer_id, p_booking_id, v_bk.brand_id, 'refund_resolution', p_booking_id::text || ':resolution',
            jsonb_build_object('decision', v_res.decision, 'reason', v_res.reason, 'operator', v_res.operator, 'resolved_at', v_res.resolved_at,
                               'refund_request_id', v_res.refund_request_id, 'refund_submitted_at', v_res.refund_submitted_at,
                               'initial_status', v_dec.status, 'initial_reason', v_dec.reason, 'category', v_dec.category))
    ON CONFLICT (kind, transition_id) DO NOTHING;
    SELECT id INTO v_event FROM public.notification_events WHERE kind = 'refund_resolution' AND transition_id = p_booking_id::text || ':resolution';
    UPDATE public.booking_cancellation_resolutions SET brand_notified_at = coalesce(brand_notified_at, now()), notice_event_id = coalesce(notice_event_id, v_event), updated_at = now(), last_error = NULL WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'escalated' THEN
    IF p_case_id IS NULL THEN RETURN jsonb_build_object('outcome', 'case_required'); END IF;
    IF p_refund_request_id IS NOT NULL AND v_res.refund_request_id IS DISTINCT FROM p_refund_request_id THEN
      RETURN jsonb_build_object('outcome', 'stale_escalation', 'resolution', to_jsonb(v_res));
    END IF;
    UPDATE public.booking_cancellation_resolutions SET escalated_at = now(), escalation_cleared_at = NULL, escalated_case_id = p_case_id, state = CASE WHEN state = 'completed' THEN state ELSE 'failed' END, last_error = coalesce(left(p_error, 300), last_error), updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    RETURN jsonb_build_object('outcome', 'marked', 'resolution', to_jsonb(v_res));
  ELSIF p_mark = 'failed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = CASE WHEN state = 'completed' THEN state ELSE 'failed' END, attempts = attempts + 1, last_error = left(p_error, 300), updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    RETURN jsonb_build_object('outcome', 'marked', 'resolution', to_jsonb(v_res));
  ELSIF p_mark = 'finalize' THEN
    NULL;   -- nothing but the shared completion rule below
  ELSE
    RETURN jsonb_build_object('outcome', 'invalid_mark');
  END IF;
  v_res := public._cancellation_resolution_finalize(p_booking_id);
  RETURN jsonb_build_object('outcome', 'marked', 'cases_closed', v_closed, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) TO service_role;

-- Post-conditions (literal-only).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_cancellation_resolutions' AND column_name = 'attempts_baseline') THEN RAISE EXCEPTION '0110 postcondition: attempts_baseline missing'; END IF;
  IF to_regprocedure('public._cancellation_resolution_finalize(uuid)') IS NULL THEN RAISE EXCEPTION '0110 postcondition: _cancellation_resolution_finalize missing'; END IF;
  IF position('_cancellation_resolution_finalize' IN pg_get_functiondef('public.booking_cancellation_relink(uuid, uuid)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0110 postcondition: relink does not finalize'; END IF;
  IF position('finalize' IN pg_get_functiondef('public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0110 postcondition: progress lacks the finalize mark'; END IF;
  IF has_function_privilege('anon', 'public._cancellation_resolution_finalize(uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0110 postcondition: anon can execute the finalizer'; END IF;
END $$;
