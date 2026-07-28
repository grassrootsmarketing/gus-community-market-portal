-- 0039_r12_integrity_and_fulfillment_cases.sql — Codex Round 12: P0-2 tail + P1-1 + P1-2.
-- Forward-only, non-destructive. Includes a PREFLIGHT that refuses to add a constraint if any
-- offending row exists (quarantine-and-report, never delete financial rows).
BEGIN;

-- ============================================================ P0-2: fulfilment retry-cap case
ALTER TABLE reconciliation_cases DROP CONSTRAINT IF EXISTS reconciliation_cases_kind_check;
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_kind_check
  CHECK (kind IN ('frozen_payment','failed_refund','settlement_exception','unmatched_refund',
                  'payment_contradiction','expiry_conflict','unknown_session','refund_requires_review',
                  'fulfillment_failed'));

CREATE OR REPLACE FUNCTION open_fulfillment_case(p_booking_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row record; v_case uuid;
BEGIN
  SELECT * INTO v_row FROM booking_fulfillments WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_row'); END IF;
  UPDATE booking_fulfillments SET status = 'failed', last_error = coalesce(p_reason, last_error),
         lease_owner = NULL, lease_expires_at = NULL
   WHERE booking_id = p_booking_id;
  v_case := _open_case('fulfillment_failed','fulfil:'||p_booking_id::text, coalesce(p_reason,'retry_cap_exhausted'),
                       v_row.payment_group_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                       jsonb_build_object('booking_id',p_booking_id,'attempts',v_row.attempts,
                                          'demo_created',v_row.demo_created,'emails_sent',v_row.emails_sent));
  RETURN jsonb_build_object('outcome','case_opened','case_id',v_case);
END $$;

-- ============================================================ P1-1: allocation booking FK + immutability
DO $$
DECLARE v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM payment_allocations a LEFT JOIN bookings b ON b.id = a.booking_id
   WHERE b.id IS NULL;
  IF v_orphans > 0 THEN
    RAISE NOTICE 'PREFLIGHT: % orphan payment_allocations rows — FK NOT added. Reconcile them, do not delete.', v_orphans;
  ELSE
    BEGIN
      ALTER TABLE payment_allocations ADD CONSTRAINT pa_booking_fk
        FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- allocation identity + money decomposition are immutable after insert (only the refund counters move)
CREATE OR REPLACE FUNCTION _pa_immutable_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_group_id <> OLD.payment_group_id
     OR NEW.booking_id      <> OLD.booking_id
     OR NEW.customer_amount <> OLD.customer_amount
     OR NEW.venue_amount    <> OLD.venue_amount
     OR NEW.platform_fee_amount <> OLD.platform_fee_amount
     OR lower(NEW.currency) <> lower(OLD.currency) THEN
    RAISE EXCEPTION 'payment_allocation identity/amounts are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pa_immutable_identity ON payment_allocations;
CREATE TRIGGER pa_immutable_identity BEFORE UPDATE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION _pa_immutable_identity();

-- ============================================================ P1-2: refund linkage immutable on UPDATE too
CREATE OR REPLACE FUNCTION _refund_linkage_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.booking_id <> OLD.booking_id OR NEW.payment_allocation_id <> OLD.payment_allocation_id THEN
    RAISE EXCEPTION 'refund booking/allocation linkage is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rr_linkage_immutable ON refund_requests;
CREATE TRIGGER rr_linkage_immutable BEFORE UPDATE ON refund_requests
  FOR EACH ROW EXECUTE FUNCTION _refund_linkage_immutable();
DROP TRIGGER IF EXISTS ro_linkage_immutable ON refund_operations;
CREATE TRIGGER ro_linkage_immutable BEFORE UPDATE ON refund_operations
  FOR EACH ROW EXECUTE FUNCTION _refund_linkage_immutable();

REVOKE ALL ON FUNCTION open_fulfillment_case(uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION open_fulfillment_case(uuid,text) TO service_role;

COMMIT;
