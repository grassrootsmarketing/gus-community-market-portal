-- 0108_cancellation_resolution_recovery.sql (2026-10-19, Codex refund-cutoff revision 4 review, R4-1 / R4-2 / R4-3)
-- Forward-only: 0106 and 0107 are applied to the test project and are left byte for byte.
--
-- R4-1  The refund mark is accepted only against the refund request's real state: 'refund_submitted' requires the
--       request to be submitted, pending or succeeded; 'refund_pending' accepts a request that is still in flight
--       (reserved, failed_retryable, requires_action, or already submitted); a terminal or parked request
--       (requires_review, failed, failed_terminal, canceled, superseded) is refused with its status so the caller
--       escalates instead of calling it submitted. Completion stays workflow completion (the request linked and
--       submitted, the case closed, the notice handed to the outbox), never a claim that the bank has paid.
-- R4-2  Escalation is durable: a resolution that exhausted its retries, or whose refund request was parked, is
--       linked to a deduplicated reconciliation case (mark 'escalated' with the case id) and leaves automatic retries
--       only once that link is recorded; a case-write failure keeps it in the selector. The abandoned-cancellation
--       discovery and closure happen in the database with the same outstanding-work filtering and fair stamping as
--       the eligibility sweep (cancellation_abandoned_outstanding / cancellation_abandoned_close).
-- R4-3  The brand's notice of a resolution is an outbox EVENT (kind refund_resolution): the notification outbox
--       resolves the live recipients (the brand account owner; bookers, pending and revoked members never), freezes
--       the payload and recipient per delivery under the delivery's provider idempotency identity, retries with
--       backoff and reports in its heartbeat. The mark 'brand_notified' inserts that event once (unique per booking).
-- Grants: service_role EXECUTE explicitly; public, anon and authenticated denied. Idempotent. No begin/commit here.

ALTER TABLE public.booking_cancellation_resolutions
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS escalated_case_id uuid,
  ADD COLUMN IF NOT EXISTS notice_event_id uuid;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS abandoned_sweep_checked_at timestamptz;

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE public.notification_events
  ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected','owner_booking_created','payment_receipt',
                  'demo_moved','demo_move_cancelled','refund_resolution'));

DROP FUNCTION IF EXISTS public.booking_cancellation_progress(uuid, uuid, text, uuid, text);

-- ---------------------------------------------------------------------------------------------
-- Progress marks: refund_submitted | refund_pending | case_closed | brand_notified | escalated | failed.
-- ---------------------------------------------------------------------------------------------
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
    -- the mark must agree with the request's real state
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
    -- hand the notice to the outbox: one event per booking (unique kind + transition_id); the outbox resolves the
    -- live recipients, freezes the payload per delivery and retries
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
    UPDATE public.booking_cancellation_resolutions SET escalated_at = coalesce(escalated_at, now()), escalated_case_id = coalesce(escalated_case_id, p_case_id), state = CASE WHEN state = 'completed' THEN state ELSE 'failed' END, last_error = coalesce(left(p_error, 300), last_error), updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    RETURN jsonb_build_object('outcome', 'marked', 'resolution', to_jsonb(v_res));
  ELSIF p_mark = 'failed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = CASE WHEN state = 'completed' THEN state ELSE 'failed' END, attempts = attempts + 1, last_error = left(p_error, 300), updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    RETURN jsonb_build_object('outcome', 'marked', 'resolution', to_jsonb(v_res));
  ELSE
    RETURN jsonb_build_object('outcome', 'invalid_mark');
  END IF;
  -- completed = the money step settled for a grant (request linked and submitted) or absent for a denial, the case
  -- closed, the notice handed to the outbox. A later 'failed' mark on another step never unsettles the money step.
  v_money_done := (v_res.decision = 'no_refund') OR (v_res.refund_request_id IS NOT NULL AND v_res.refund_submitted_at IS NOT NULL);
  IF v_money_done AND v_res.case_closed_at IS NOT NULL AND v_res.brand_notified_at IS NOT NULL AND v_res.state <> 'completed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = 'completed', updated_at = now() WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    -- a completed resolution closes its own escalation case (the operator finished the work it named)
    IF v_res.escalated_case_id IS NOT NULL THEN
      UPDATE public.reconciliation_cases SET status = 'resolved', resolved_by = coalesce(v_res.operator, 'refund-review'), resolved_at = now() WHERE id = v_res.escalated_case_id AND status <> 'resolved';
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', 'marked', 'cases_closed', v_closed, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid) TO service_role;

-- Resolutions that still owe a step and are not yet escalated, past the grace period, fair order. The attempt cap
-- is applied by the worker: a row at the cap is escalated (linked to its case) and only then leaves this selection.
CREATE OR REPLACE FUNCTION public.cancellation_resolutions_unfinished(p_limit integer DEFAULT 25, p_grace_seconds integer DEFAULT 120)
RETURNS SETOF public.booking_cancellation_resolutions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH pick AS (
    SELECT r.booking_id FROM public.booking_cancellation_resolutions r
     WHERE r.state <> 'completed' AND r.escalated_at IS NULL AND r.updated_at < now() - make_interval(secs => greatest(0, coalesce(p_grace_seconds, 120)))
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

-- ---------------------------------------------------------------------------------------------
-- Abandoned recorded cancellations: discovery (outstanding only, stamped, fair) and closure (batched, in SQL).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancellation_abandoned_outstanding(p_limit integer DEFAULT 25, p_minutes integer DEFAULT 15)
RETURNS TABLE(booking_id uuid, retailer_id uuid, status text, payment_status text, cancellation_pending_at timestamptz, checked_before timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH pick AS (
    SELECT b.id, b.abandoned_sweep_checked_at
      FROM public.bookings b
     WHERE b.cancellation_pending_at IS NOT NULL
       AND b.cancellation_pending_at < now() - make_interval(mins => greatest(0, coalesce(p_minutes, 15)))
       AND b.status IN ('pending', 'confirmed', 'held')
       AND NOT EXISTS (SELECT 1 FROM public.reconciliation_cases k WHERE k.dedupe_key = 'cancel-abandoned:' || b.id::text)
     ORDER BY b.abandoned_sweep_checked_at ASC NULLS FIRST, b.cancellation_pending_at ASC
     LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
     FOR UPDATE OF b SKIP LOCKED
  ), stamped AS (
    UPDATE public.bookings b SET abandoned_sweep_checked_at = now()
      FROM pick WHERE b.id = pick.id
    RETURNING b.id, b.retailer_id, b.status, b.payment_status, b.cancellation_pending_at, pick.abandoned_sweep_checked_at AS checked_before
  )
  SELECT s.id, s.retailer_id, s.status, s.payment_status, s.cancellation_pending_at, s.checked_before FROM stamped s;
END $$;
REVOKE ALL ON FUNCTION public.cancellation_abandoned_outstanding(integer, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancellation_abandoned_outstanding(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cancellation_abandoned_close(p_limit integer DEFAULT 25)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n integer := 0;
BEGIN
  WITH pick AS (
    SELECT c.id FROM public.reconciliation_cases c
      JOIN public.bookings b ON c.dedupe_key = 'cancel-abandoned:' || b.id::text
     WHERE c.dedupe_key LIKE 'cancel-abandoned:%' AND c.status <> 'resolved' AND b.cancellation_pending_at IS NULL
     ORDER BY c.created_at ASC
     LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
     FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE public.reconciliation_cases c SET status = 'resolved', resolved_by = coalesce(c.resolved_by, 'refund-worker'), resolved_at = now()
    FROM pick WHERE c.id = pick.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.cancellation_abandoned_close(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancellation_abandoned_close(integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_cancellation_resolutions' AND column_name = 'escalated_at') THEN RAISE EXCEPTION '0108 postcondition: resolutions.escalated_at missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'abandoned_sweep_checked_at') THEN RAISE EXCEPTION '0108 postcondition: bookings.abandoned_sweep_checked_at missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_progress(uuid, uuid, text, uuid, text)') IS NOT NULL THEN RAISE EXCEPTION '0108 postcondition: the 0107 progress function still exists'; END IF;
  IF to_regprocedure('public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)') IS NULL THEN RAISE EXCEPTION '0108 postcondition: booking_cancellation_progress (6 args) missing'; END IF;
  IF to_regprocedure('public.cancellation_abandoned_outstanding(integer, integer)') IS NULL OR to_regprocedure('public.cancellation_abandoned_close(integer)') IS NULL THEN RAISE EXCEPTION '0108 postcondition: abandoned sweep functions missing'; END IF;
  IF position('refund_resolution' IN (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'notification_events_kind_check' AND conrelid = 'public.notification_events'::regclass)) = 0 THEN RAISE EXCEPTION '0108 postcondition: refund_resolution not in the event kind check'; END IF;
  IF NOT has_function_privilege('service_role', 'public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0108 postcondition: service_role cannot execute booking_cancellation_progress'; END IF;
  IF has_function_privilege('anon', 'public.cancellation_abandoned_close(integer)', 'EXECUTE') THEN RAISE EXCEPTION '0108 postcondition: anon can execute cancellation_abandoned_close'; END IF;
END $$;
