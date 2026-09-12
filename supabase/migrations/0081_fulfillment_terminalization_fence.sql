-- 0081_fulfillment_terminalization_fence.sql
-- Codex Release B round-4 review (2026-09-12), R4-01 (P1): C1's completion fence had a bypass. After a
-- capture re-issued a held row as generation 2, a STALE held worker whose completion was (correctly)
-- refused could still hit the retry cap and call open_fulfillment_case(booking_id, reason), which
-- updated the CURRENT row by booking id — no owner, no generation — parking the replacement paid work
-- as 'failed' and stranding a paid booking until an operator noticed.
--
-- Fix: ONE transactional operation, record_fulfillment(), locks the row and validates the caller's
-- claim (lease owner AND generation AND status 'pending') before it records progress, completes the
-- work, or — when the CURRENT row's attempts have reached the cap — parks it and opens its
-- deduplicated case, atomically. An obsolete generation or a lost lease is a no-op ('stale').
-- The unguarded two-argument open_fulfillment_case() is DROPPED so no deployed code, old or new, can
-- park replacement work without a claim. complete_fulfillment(…, p_generation) (0078) is kept: it is
-- fenced the same way and the lifecycle suite exercises it directly.
-- Forward-only; 0039 / 0078 / 0080 untouched.

DROP FUNCTION IF EXISTS open_fulfillment_case(uuid, text);

CREATE OR REPLACE FUNCTION record_fulfillment(
  p_booking_id uuid, p_owner text, p_generation integer,
  p_demo boolean, p_emails boolean, p_done boolean, p_err text, p_max_attempts integer DEFAULT 6)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v booking_fulfillments%ROWTYPE; v_case uuid; v_demo boolean; v_emails boolean; v_cap integer;
BEGIN
  IF p_booking_id IS NULL OR p_owner IS NULL OR p_generation IS NULL THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason', 'missing_claim');
  END IF;
  SELECT * INTO v FROM booking_fulfillments WHERE booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'stale', 'reason', 'no_row'); END IF;
  -- The claim must still be the CURRENT one: same lease owner, same generation, still pending.
  IF v.lease_owner IS DISTINCT FROM p_owner OR v.generation IS DISTINCT FROM p_generation OR v.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason',
      CASE WHEN v.status <> 'pending' THEN 'row_' || v.status
           WHEN v.generation IS DISTINCT FROM p_generation THEN 'generation_' || v.generation::text
           ELSE 'lease_' || coalesce(v.lease_owner, 'none') END,
      'generation', v.generation, 'status', v.status);
  END IF;

  v_demo := v.demo_created OR coalesce(p_demo, false);
  v_emails := v.emails_sent OR coalesce(p_emails, false);
  v_cap := greatest(1, coalesce(p_max_attempts, 6));

  IF coalesce(p_done, false) THEN
    UPDATE booking_fulfillments
       SET demo_created = v_demo, emails_sent = v_emails, status = 'done', completed_at = now(),
           last_error = coalesce(p_err, last_error), lease_owner = NULL, lease_expires_at = NULL
     WHERE booking_id = p_booking_id;
    RETURN jsonb_build_object('outcome', 'done', 'generation', v.generation, 'attempts', v.attempts);
  END IF;

  IF v.attempts >= v_cap THEN
    -- Legitimate exhaustion of THIS claim: park only this work and open its case, in this transaction.
    UPDATE booking_fulfillments
       SET demo_created = v_demo, emails_sent = v_emails, status = 'failed',
           last_error = coalesce(p_err, last_error, 'retry_cap_exhausted'), lease_owner = NULL, lease_expires_at = NULL
     WHERE booking_id = p_booking_id;
    v_case := _open_case('fulfillment_failed', 'fulfil:' || p_booking_id::text, coalesce(p_err, 'retry_cap_exhausted'),
                         v.payment_group_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                         jsonb_build_object('booking_id', p_booking_id, 'attempts', v.attempts, 'generation', v.generation,
                                            'demo_created', v_demo, 'emails_sent', v_emails));
    RETURN jsonb_build_object('outcome', 'exhausted', 'case_id', v_case, 'generation', v.generation, 'attempts', v.attempts);
  END IF;

  -- Progress on a still-live claim: keep what was done, release the lease for the next attempt.
  UPDATE booking_fulfillments
     SET demo_created = v_demo, emails_sent = v_emails, last_error = coalesce(p_err, last_error),
         lease_owner = NULL, lease_expires_at = NULL
   WHERE booking_id = p_booking_id;
  RETURN jsonb_build_object('outcome', 'progress', 'generation', v.generation, 'attempts', v.attempts);
END $$;
REVOKE ALL ON FUNCTION record_fulfillment(uuid,text,integer,boolean,boolean,boolean,text,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_fulfillment(uuid,text,integer,boolean,boolean,boolean,text,integer) TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.open_fulfillment_case(uuid,text)') IS NOT NULL THEN
    RAISE EXCEPTION '0081 postcondition: unguarded open_fulfillment_case must be gone';
  END IF;
  IF to_regprocedure('public.record_fulfillment(uuid,text,integer,boolean,boolean,boolean,text,integer)') IS NULL THEN
    RAISE EXCEPTION '0081 postcondition: record_fulfillment missing';
  END IF;
  -- a caller without a live claim can change nothing
  IF (record_fulfillment('00000000-0000-4000-8000-000000000000'::uuid, 'nobody', 1, true, true, false, 'x', 1)->>'outcome') <> 'stale' THEN
    RAISE EXCEPTION '0081 postcondition: a claimless call must be a stale no-op';
  END IF;
END $$;
