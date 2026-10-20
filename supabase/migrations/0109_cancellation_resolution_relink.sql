-- 0109_cancellation_resolution_relink.sql (2026-10-19, Codex refund-cutoff revision 5 review, R5-1 / R5-2)
-- Forward-only: 0106 to 0108 are applied to the test project and are left byte for byte.
--
-- R5-1  When an operator replaces a parked refund request through the supported route (resolve_refund_replace, 0044:
--       the old request is superseded and a successor is created under the SAME refund operation), the resolution
--       must follow the successor. booking_cancellation_relink() is the only path that changes a resolution's
--       linked request: under the booking's lock it requires the linked request to be superseded, derives the
--       successor server-side (same parent operation, booking and payment allocation, a newer attempt, not itself
--       superseded or canceled, recorded by a 'replace' review action of this retailer's operation), links it, and
--       sets the money mark from the successor's REAL state (submitted only if submitted/pending/succeeded; in flight
--       otherwise; a parked successor stays unsubmitted so the caller escalates again). Repeated replacements follow
--       the chain. The resolution helper never submits the successor: the refund worker owns that.
--       An escalation mark that names a parked request applies only while that request is still the linked one; a
--       mark that arrives after a replacement relinked the resolution is refused as stale_escalation (a concurrent
--       replay must never re-escalate a re-armed resolution). Completion closes every escalation case of the booking.
-- R5-2  An escalation that has been re-armed by a replacement (or finished by an operator) is distinguished from an
--       active one: escalated_at stays as audit, escalation_cleared_at says the escalation is no longer active. A
--       new escalation resets both. The unfinished selector re-arms automatically: a row whose linked request is
--       superseded is selected even while its escalation is active, so completion never depends on an operator
--       guessing when to replay.
-- Grants: service_role EXECUTE explicitly; public, anon and authenticated denied. Idempotent. No begin/commit here.

ALTER TABLE public.booking_cancellation_resolutions ADD COLUMN IF NOT EXISTS escalation_cleared_at timestamptz;

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
  -- the successor: same operation, booking and allocation; a newer attempt; not retired; recorded by this retailer's replace action
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
         last_error = NULL, updated_at = now()
   WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  RETURN jsonb_build_object('outcome', 'relinked', 'previous_request_id', v_old.id, 'request_id', v_new.id, 'request_status', v_new.status, 'attempt_version', v_new.attempt_version, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_relink(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_relink(uuid, uuid) TO service_role;

-- A new escalation is ACTIVE: escalated_at reset to now, escalation_cleared_at cleared (0108's mark kept the first timestamp).
CREATE OR REPLACE FUNCTION public.booking_cancellation_progress(p_booking_id uuid, p_retailer_id uuid, p_mark text, p_refund_request_id uuid DEFAULT NULL, p_error text DEFAULT NULL, p_case_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_res public.booking_cancellation_resolutions%ROWTYPE; v_rq record; v_grp_retailer uuid; v_closed integer := 0; v_money_done boolean; v_event uuid; v_dec record;
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
    -- an escalation about a parked request is stale once a replacement has relinked the resolution (R5-1 race):
    -- nothing is written, the caller continues from the current row
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
  ELSE
    RETURN jsonb_build_object('outcome', 'invalid_mark');
  END IF;
  v_money_done := (v_res.decision = 'no_refund') OR (v_res.refund_request_id IS NOT NULL AND v_res.refund_submitted_at IS NOT NULL);
  IF v_money_done AND v_res.case_closed_at IS NOT NULL AND v_res.brand_notified_at IS NOT NULL AND v_res.state <> 'completed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = 'completed', escalation_cleared_at = CASE WHEN escalated_at IS NOT NULL THEN coalesce(escalation_cleared_at, now()) ELSE escalation_cleared_at END, updated_at = now() WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    -- a completed resolution closes its own escalation case (the operator finished the work it named)
    UPDATE public.reconciliation_cases SET status = 'resolved', resolved_by = coalesce(v_res.operator, 'refund-review'), resolved_at = now()
     WHERE (id = v_res.escalated_case_id OR dedupe_key = 'resolution-failed:' || p_booking_id::text) AND status <> 'resolved';
  END IF;
  RETURN jsonb_build_object('outcome', 'marked', 'cases_closed', v_closed, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) TO service_role;

-- Unfinished rows: not actively escalated, OR actively escalated but with a superseded link (a replacement happened:
-- re-armed automatically). Past the grace period, fair order; the attempt cap is applied by the worker.
CREATE OR REPLACE FUNCTION public.cancellation_resolutions_unfinished(p_limit integer DEFAULT 25, p_grace_seconds integer DEFAULT 120)
RETURNS SETOF public.booking_cancellation_resolutions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH pick AS (
    SELECT r.booking_id FROM public.booking_cancellation_resolutions r
     WHERE r.state <> 'completed'
       AND (r.escalated_at IS NULL OR r.escalation_cleared_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.refund_requests q WHERE q.id = r.refund_request_id AND q.status = 'superseded'))
       AND r.updated_at < now() - make_interval(secs => greatest(0, coalesce(p_grace_seconds, 120)))
     ORDER BY r.updated_at ASC
     LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
     FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.booking_cancellation_resolutions r SET attempts = r.attempts + 1, updated_at = now()
    FROM pick WHERE r.booking_id = pick.booking_id
  RETURNING r.*;
END $$;
REVOKE ALL ON FUNCTION public.cancellation_resolutions_unfinished(integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancellation_resolutions_unfinished(integer, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_cancellation_resolutions' AND column_name = 'escalation_cleared_at') THEN RAISE EXCEPTION '0109 postcondition: escalation_cleared_at missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_relink(uuid, uuid)') IS NULL THEN RAISE EXCEPTION '0109 postcondition: booking_cancellation_relink missing'; END IF;
  IF position('escalation_cleared_at' IN pg_get_functiondef('public.cancellation_resolutions_unfinished(integer, integer)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0109 postcondition: the unfinished selector lacks the re-arm rule'; END IF;
  IF NOT has_function_privilege('service_role', 'public.booking_cancellation_relink(uuid, uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0109 postcondition: service_role cannot execute booking_cancellation_relink'; END IF;
  IF has_function_privilege('anon', 'public.booking_cancellation_relink(uuid, uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0109 postcondition: anon can execute booking_cancellation_relink'; END IF;
END $$;
