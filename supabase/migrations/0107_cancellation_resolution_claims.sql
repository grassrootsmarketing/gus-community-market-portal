-- 0107_cancellation_resolution_claims.sql (2026-10-19, Codex refund-cutoff revision 3 review, R3-1 / R3-2 / R3-3)
-- Forward-only: 0106 is applied to the test project and is left byte for byte.
--
-- R3-1  The operator's decision is CLAIMED before any provider effect. booking_cancellation_claim() inserts the
--       resolution row (state 'claimed') under the booking's lock, or returns the existing one. Only the request that
--       won the claim (or a replay continuing that same stored decision) performs the money step; an opposing request
--       gets the stored decision back and issues nothing. The row separates the operator's choice (decision) from
--       execution (state: claimed, refund_submitted, refund_pending, completed, failed), so a grant is never called
--       completed money.
-- R3-3  Every later step is recorded on the same row by booking_cancellation_progress(): the refund request it
--       created (validated against the booking and the retailer's payment group, not merely stored), the review case
--       closed (done inside the RPC, atomically with the mark), the brand notified (under a deterministic notice key
--       stored on the row). A replay or the refund worker resumes whatever is not yet marked. The row is 'completed'
--       only when every step is marked.
-- R3-2  cancellation_reviews_outstanding(): the sweep's selection happens in the database (no resolution, no case),
--       ordered so a row the sweep already attempted rotates behind the rest (review_sweep_checked_at), and the
--       selected rows are stamped in the same statement. cancellation_resolutions_unfinished() does the same for
--       resolutions that still owe a step. Both are bounded and fair; neither loads the table.
-- Grants: service_role EXECUTE explicitly; public, anon and authenticated denied.
-- Idempotent. No begin/commit here: the production paste wraps it.

ALTER TABLE public.booking_cancellation_resolutions
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS refund_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS case_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS brand_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS notice_key text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_cancellation_resolutions_state_check') THEN
    ALTER TABLE public.booking_cancellation_resolutions
      ADD CONSTRAINT booking_cancellation_resolutions_state_check CHECK (state IN ('claimed', 'refund_submitted', 'refund_pending', 'completed', 'failed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS booking_cancellation_resolutions_unfinished ON public.booking_cancellation_resolutions (updated_at) WHERE state <> 'completed';
ALTER TABLE public.booking_cancellations ADD COLUMN IF NOT EXISTS review_sweep_checked_at timestamptz;

DROP FUNCTION IF EXISTS public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid);

-- ---------------------------------------------------------------------------------------------
-- The claim: first writer wins; everyone else gets the stored decision.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_claim(p_booking_id uuid, p_retailer_id uuid, p_decision text, p_operator text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_dec public.booking_cancellations%ROWTYPE; v_res public.booking_cancellation_resolutions%ROWTYPE; v_case uuid;
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
  IF v_dec.status = 'not_paid' AND v_bk.payment_status IS DISTINCT FROM 'paid' THEN RETURN jsonb_build_object('outcome', 'nothing_to_refund', 'decision', to_jsonb(v_dec)); END IF;
  SELECT id INTO v_case FROM public.reconciliation_cases WHERE dedupe_key = 'refund-eligibility:' || p_booking_id::text LIMIT 1;
  INSERT INTO public.booking_cancellation_resolutions (booking_id, retailer_id, decision, operator, reason, case_id, state, notice_key, attempts, updated_at)
  VALUES (p_booking_id, p_retailer_id, p_decision, p_operator, left(btrim(p_reason), 500), v_case, 'claimed', 'cancellation-resolution:' || p_booking_id::text || ':' || p_decision, 0, now())
  RETURNING * INTO v_res;
  RETURN jsonb_build_object('outcome', 'claimed', 'existing', false, 'resolution', to_jsonb(v_res), 'decision', to_jsonb(v_dec));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_claim(uuid, uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_claim(uuid, uuid, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- Progress marks on the claimed row. p_mark: refund_submitted | refund_pending | case_closed | brand_notified | failed.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_progress(p_booking_id uuid, p_retailer_id uuid, p_mark text, p_refund_request_id uuid DEFAULT NULL, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_res public.booking_cancellation_resolutions%ROWTYPE; v_rq record; v_grp_retailer uuid; v_closed integer := 0; v_money_done boolean;
BEGIN
  SELECT id, retailer_id INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_resolution'); END IF;
  IF p_mark IN ('refund_submitted', 'refund_pending') THEN
    IF v_res.decision <> 'refund_granted' THEN RETURN jsonb_build_object('outcome', 'not_a_grant', 'resolution', to_jsonb(v_res)); END IF;
    IF p_refund_request_id IS NULL THEN RETURN jsonb_build_object('outcome', 'refund_request_required'); END IF;
    -- the linked refund request must be this booking's and sit on this retailer's payment group
    SELECT rq.id, rq.booking_id, rq.payment_allocation_id, rq.status INTO v_rq FROM public.refund_requests rq WHERE rq.id = p_refund_request_id;
    IF NOT FOUND OR v_rq.booking_id IS DISTINCT FROM p_booking_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch'); END IF;
    SELECT g.retailer_id INTO v_grp_retailer FROM public.payment_allocations a JOIN public.payment_groups g ON g.id = a.payment_group_id WHERE a.id = v_rq.payment_allocation_id;
    IF v_grp_retailer IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch'); END IF;
    IF v_res.refund_request_id IS NOT NULL AND v_res.refund_request_id <> p_refund_request_id THEN RETURN jsonb_build_object('outcome', 'refund_request_mismatch', 'resolution', to_jsonb(v_res)); END IF;
    UPDATE public.booking_cancellation_resolutions
       SET refund_request_id = p_refund_request_id, refund_submitted_at = CASE WHEN p_mark = 'refund_submitted' THEN coalesce(refund_submitted_at, now()) ELSE refund_submitted_at END,
           state = p_mark, last_error = NULL, updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'case_closed' THEN
    UPDATE public.reconciliation_cases SET status = 'resolved', resolved_by = coalesce(v_res.operator, 'refund-review'), resolved_at = now()
     WHERE dedupe_key = 'refund-eligibility:' || p_booking_id::text AND status <> 'resolved';
    GET DIAGNOSTICS v_closed = ROW_COUNT;
    UPDATE public.booking_cancellation_resolutions SET case_closed_at = coalesce(case_closed_at, now()), updated_at = now(), last_error = NULL WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'brand_notified' THEN
    UPDATE public.booking_cancellation_resolutions SET brand_notified_at = coalesce(brand_notified_at, now()), updated_at = now(), last_error = NULL WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  ELSIF p_mark = 'failed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = CASE WHEN state = 'completed' THEN state ELSE 'failed' END, attempts = attempts + 1, last_error = left(p_error, 300), updated_at = now()
     WHERE booking_id = p_booking_id RETURNING * INTO v_res;
    RETURN jsonb_build_object('outcome', 'marked', 'resolution', to_jsonb(v_res));
  ELSE
    RETURN jsonb_build_object('outcome', 'invalid_mark');
  END IF;
  -- completed = the money step is settled for a grant (request linked and submitted, not merely pending; a later 'failed'
  -- mark on the notice step does not unsettle it) or absent for a denial,
  -- the case is closed, the brand is told
  v_money_done := (v_res.decision = 'no_refund') OR (v_res.refund_request_id IS NOT NULL AND v_res.refund_submitted_at IS NOT NULL);
  IF v_money_done AND v_res.case_closed_at IS NOT NULL AND v_res.brand_notified_at IS NOT NULL AND v_res.state <> 'completed' THEN
    UPDATE public.booking_cancellation_resolutions SET state = 'completed', updated_at = now() WHERE booking_id = p_booking_id RETURNING * INTO v_res;
  END IF;
  RETURN jsonb_build_object('outcome', 'marked', 'cases_closed', v_closed, 'resolution', to_jsonb(v_res));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_progress(uuid, uuid, text, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- The review sweep's selection: outstanding work only, chosen and stamped in the database.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancellation_reviews_outstanding(p_limit integer DEFAULT 25)
RETURNS TABLE(booking_id uuid, retailer_id uuid, category text, requested_at timestamptz, start_source text, demo_date date, demo_time text, payment_intent_id text, checked_before timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH pick AS (
    SELECT c.booking_id, c.review_sweep_checked_at
      FROM public.booking_cancellations c
     WHERE c.status = 'under_review'
       AND NOT EXISTS (SELECT 1 FROM public.booking_cancellation_resolutions r WHERE r.booking_id = c.booking_id)
       AND NOT EXISTS (SELECT 1 FROM public.reconciliation_cases k WHERE k.dedupe_key = 'refund-eligibility:' || c.booking_id::text)
     ORDER BY c.review_sweep_checked_at ASC NULLS FIRST, c.decided_at ASC
     LIMIT greatest(1, least(coalesce(p_limit, 25), 100))
     FOR UPDATE OF c SKIP LOCKED
  ), stamped AS (
    UPDATE public.booking_cancellations c SET review_sweep_checked_at = now()
      FROM pick WHERE c.booking_id = pick.booking_id
    RETURNING c.booking_id, c.retailer_id, c.category, c.requested_at, c.start_source, pick.review_sweep_checked_at AS checked_before
  )
  SELECT s.booking_id, s.retailer_id, s.category, s.requested_at, s.start_source, b.demo_date, b.demo_time, b.payment_intent_id, s.checked_before
    FROM stamped s JOIN public.bookings b ON b.id = s.booking_id;
END $$;
REVOKE ALL ON FUNCTION public.cancellation_reviews_outstanding(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancellation_reviews_outstanding(integer) TO service_role;

-- Resolutions that still owe a step (older than the grace period so a request still running is not raced), fair order;
-- after 20 attempts a row is left 'failed' with its case open (explicitly actionable) rather than retried forever.
CREATE OR REPLACE FUNCTION public.cancellation_resolutions_unfinished(p_limit integer DEFAULT 25, p_grace_seconds integer DEFAULT 120)
RETURNS SETOF public.booking_cancellation_resolutions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH pick AS (
    SELECT r.booking_id FROM public.booking_cancellation_resolutions r
     WHERE r.state <> 'completed' AND r.attempts < 20 AND r.updated_at < now() - make_interval(secs => greatest(0, coalesce(p_grace_seconds, 120)))
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
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_cancellation_resolutions' AND column_name = 'state') THEN RAISE EXCEPTION '0107 postcondition: resolutions.state missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_cancellations' AND column_name = 'review_sweep_checked_at') THEN RAISE EXCEPTION '0107 postcondition: review_sweep_checked_at missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid)') IS NOT NULL THEN RAISE EXCEPTION '0107 postcondition: the 0106 resolve function still exists'; END IF;
  IF to_regprocedure('public.booking_cancellation_claim(uuid, uuid, text, text, text)') IS NULL THEN RAISE EXCEPTION '0107 postcondition: booking_cancellation_claim missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_progress(uuid, uuid, text, uuid, text)') IS NULL THEN RAISE EXCEPTION '0107 postcondition: booking_cancellation_progress missing'; END IF;
  IF to_regprocedure('public.cancellation_reviews_outstanding(integer)') IS NULL THEN RAISE EXCEPTION '0107 postcondition: cancellation_reviews_outstanding missing'; END IF;
  IF to_regprocedure('public.cancellation_resolutions_unfinished(integer, integer)') IS NULL THEN RAISE EXCEPTION '0107 postcondition: cancellation_resolutions_unfinished missing'; END IF;
  IF NOT has_function_privilege('service_role', 'public.booking_cancellation_claim(uuid, uuid, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0107 postcondition: service_role cannot execute booking_cancellation_claim'; END IF;
  IF has_function_privilege('anon', 'public.booking_cancellation_claim(uuid, uuid, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0107 postcondition: anon can execute booking_cancellation_claim'; END IF;
END $$;
