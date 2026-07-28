-- 0037_open_case_fix.sql — corrective: _open_case() could not use ON CONFLICT.
--
-- 0036 created a PARTIAL unique index (`... WHERE dedupe_key IS NOT NULL`). Postgres cannot infer a
-- partial index in `ON CONFLICT (dedupe_key)` unless the predicate is restated, so every
-- case-opening path raised 42P10 — which meant apply_verified_payment failed instead of
-- quarantining. Fix: catch unique_violation and re-select (works with the partial index, and is
-- race-safe under concurrent webhook retries).
BEGIN;

CREATE OR REPLACE FUNCTION _open_case(
  p_kind text, p_dedupe text, p_reason text, p_group uuid, p_request uuid, p_operation uuid,
  p_session text, p_pi text, p_charge text, p_refund text, p_amount integer, p_currency text, p_details jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_dedupe IS NOT NULL THEN
    SELECT id INTO v_id FROM reconciliation_cases WHERE dedupe_key = p_dedupe;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  BEGIN
    INSERT INTO reconciliation_cases(kind, dedupe_key, reason, payment_group_id, refund_request_id, refund_operation_id,
        stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id, stripe_refund_id, amount, currency, details)
      VALUES (p_kind, p_dedupe, p_reason, p_group, p_request, p_operation, p_session, p_pi, p_charge, p_refund, p_amount, p_currency, p_details)
      RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM reconciliation_cases WHERE dedupe_key = p_dedupe;   -- concurrent opener won
  END;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION _open_case(text,text,text,uuid,uuid,uuid,text,text,text,text,integer,text,jsonb) FROM public, anon, authenticated;

COMMIT;
