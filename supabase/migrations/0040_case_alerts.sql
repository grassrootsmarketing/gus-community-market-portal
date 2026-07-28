-- 0040_case_alerts.sql — Codex Round 12 P0-5: external alerting for financial exceptions.
-- Adds delivery tracking to reconciliation_cases plus a leased claim/mark pair so an alert worker
-- can send exactly-once-ish (at-least-once with dedupe) without a second alert per retry.
BEGIN;

ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_status text NOT NULL DEFAULT 'pending'
  CHECK (alert_status IN ('pending','sent','failed','suppressed'));
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_last_error text;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_message_id text;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_sent_at timestamptz;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_lease_owner text;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS alert_lease_expires_at timestamptz;
CREATE INDEX IF NOT EXISTS recon_alert_pending_idx ON reconciliation_cases(alert_status) WHERE alert_status = 'pending';

-- Claim un-alerted cases (SKIP LOCKED, leased) — one alert per case id, never per retry.
CREATE OR REPLACE FUNCTION claim_case_alerts(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb;
BEGIN
  WITH due AS (
    SELECT c.id FROM reconciliation_cases c
    WHERE c.alert_status = 'pending'
      AND c.alert_attempts < 8
      AND (c.alert_lease_expires_at IS NULL OR c.alert_lease_expires_at < now())
    ORDER BY c.created_at ASC
    LIMIT greatest(1, coalesce(p_limit,20))
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE reconciliation_cases c
      SET alert_lease_owner = p_owner,
          alert_lease_expires_at = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds,120))),
          alert_attempts = c.alert_attempts + 1
    FROM due WHERE c.id = due.id
    RETURNING c.id, c.kind, c.reason, c.amount, c.currency, c.payment_group_id, c.refund_request_id,
              c.stripe_checkout_session_id, c.stripe_payment_intent_id, c.stripe_charge_id, c.stripe_refund_id,
              c.details, c.created_at, c.alert_attempts
  )
  SELECT coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) INTO v_rows FROM leased;
  RETURN v_rows;
END $$;

CREATE OR REPLACE FUNCTION mark_case_alert(p_case_id uuid, p_owner text, p_ok boolean, p_message_id text, p_err text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE reconciliation_cases
     SET alert_status = CASE WHEN coalesce(p_ok,false) THEN 'sent'
                             WHEN alert_attempts >= 8 THEN 'failed'
                             ELSE 'pending' END,
         alert_message_id = coalesce(p_message_id, alert_message_id),
         alert_sent_at = CASE WHEN coalesce(p_ok,false) THEN now() ELSE alert_sent_at END,
         alert_last_error = coalesce(p_err, alert_last_error),
         alert_lease_owner = NULL, alert_lease_expires_at = NULL
   WHERE id = p_case_id AND alert_lease_owner = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

REVOKE ALL ON FUNCTION claim_case_alerts(text,integer,integer)            FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION mark_case_alert(uuid,text,boolean,text,text)       FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_case_alerts(text,integer,integer)          TO service_role;
GRANT EXECUTE ON FUNCTION mark_case_alert(uuid,text,boolean,text,text)     TO service_role;

COMMIT;
