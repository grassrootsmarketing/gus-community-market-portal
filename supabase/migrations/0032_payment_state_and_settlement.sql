-- 0032_payment_state_and_settlement.sql — Codex reverify #10 forward migration (DB layer).
--
-- Adds the state + settlement substrate the payment/refund correctness work needs, WITHOUT
-- rewriting 0029–0031 and WITHOUT deleting any financial history:
--   * immutable payment-attempt records (one row per Checkout Session attempt on one group);
--   * immutable group financial snapshot (charge model / Connect / currency / fee-policy version)
--     + captured Stripe settlement identifiers (transfer, application fee);
--   * money-decomposition + cross-row invariants (customer = venue + platform fee; group = Σ);
--   * a parent "refund operation" so a FAILED refund can spawn an authorized replacement attempt
--     (the old globally-unique op_key made that impossible);
--   * per-leg settlement columns for exact Connect reversals (customer refund / transfer reversal
--     / application-fee refund) so heterogeneous-fee carts settle exactly, not proportionally;
--   * a refund-worker lease (owner / expiry / next_attempt_at) and typed retry states;
--   * durable reconciliation_cases for frozen payments, failed refunds, settlement exceptions.
--
-- RPCs that consume these columns land in 0033 (apply_verified_payment, apply_refund_event, the
-- refund CAS command, exact-settlement helpers, attempt expiry, worker lease claim). This file is
-- schema + invariants + immutability only, so it is safe to apply before the handler cutover.
BEGIN;

-- =====================================================================================
-- 1. payment_groups: immutable financial snapshot + captured settlement identifiers
-- =====================================================================================
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS fee_policy_version    integer NOT NULL DEFAULT 1;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS request_schema_version integer;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS canonical_request_hash text;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS stripe_transfer_id     text;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS stripe_application_fee_id text;
CREATE UNIQUE INDEX IF NOT EXISTS payment_groups_transfer_uidx ON payment_groups(stripe_transfer_id) WHERE stripe_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_groups_appfee_uidx   ON payment_groups(stripe_application_fee_id) WHERE stripe_application_fee_id IS NOT NULL;

-- brand/retailer FKs (P1-6)
DO $$ BEGIN
  ALTER TABLE payment_groups ADD CONSTRAINT pg_brand_fk    FOREIGN KEY (brand_id)    REFERENCES brands(id)    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payment_groups ADD CONSTRAINT pg_retailer_fk FOREIGN KEY (retailer_id) REFERENCES retailers(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- immutable snapshot: the money-routing identity of a group can never change after creation.
-- Stripe id columns are write-once (null -> value; never value -> different value). total may move
-- 0 -> final only while status='pending' (during the claim that builds the allocations).
CREATE OR REPLACE FUNCTION _pg_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.brand_id <> OLD.brand_id OR NEW.retailer_id <> OLD.retailer_id
     OR NEW.currency <> OLD.currency OR NEW.platform_keeps_all <> OLD.platform_keeps_all
     OR coalesce(NEW.connect_account_id,'') <> coalesce(OLD.connect_account_id,'')
     OR NEW.fee_policy_version <> OLD.fee_policy_version THEN
    RAISE EXCEPTION 'payment_group financial snapshot is immutable';
  END IF;
  IF NEW.total_customer_amount <> OLD.total_customer_amount AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'payment_group total is immutable once out of pending';
  END IF;
  -- write-once Stripe identity
  IF OLD.stripe_checkout_session_id IS NOT NULL AND NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id THEN RAISE EXCEPTION 'session id write-once'; END IF;
  IF OLD.stripe_payment_intent_id   IS NOT NULL AND NEW.stripe_payment_intent_id   IS DISTINCT FROM OLD.stripe_payment_intent_id   THEN RAISE EXCEPTION 'pi id write-once'; END IF;
  IF OLD.stripe_charge_id           IS NOT NULL AND NEW.stripe_charge_id           IS DISTINCT FROM OLD.stripe_charge_id           THEN RAISE EXCEPTION 'charge id write-once'; END IF;
  IF OLD.stripe_transfer_id         IS NOT NULL AND NEW.stripe_transfer_id         IS DISTINCT FROM OLD.stripe_transfer_id         THEN RAISE EXCEPTION 'transfer id write-once'; END IF;
  IF OLD.stripe_application_fee_id  IS NOT NULL AND NEW.stripe_application_fee_id  IS DISTINCT FROM OLD.stripe_application_fee_id  THEN RAISE EXCEPTION 'app fee id write-once'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pg_immutable ON payment_groups;
CREATE TRIGGER pg_immutable BEFORE UPDATE ON payment_groups FOR EACH ROW EXECUTE FUNCTION _pg_immutable();

-- =====================================================================================
-- 2. payment_allocations: money decomposition + currency-equals-group invariants
-- =====================================================================================
DO $$ BEGIN
  ALTER TABLE payment_allocations ADD CONSTRAINT pa_amount_decomposition CHECK (customer_amount = venue_amount + platform_fee_amount);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- allocation.currency must equal its group's currency (cross-row -> enforced by trigger)
CREATE OR REPLACE FUNCTION _pa_currency_matches_group() RETURNS trigger AS $$
DECLARE g_cur text;
BEGIN
  SELECT currency INTO g_cur FROM payment_groups WHERE id = NEW.payment_group_id;
  IF g_cur IS NOT NULL AND lower(NEW.currency) <> lower(g_cur) THEN
    RAISE EXCEPTION 'allocation currency % <> group currency %', NEW.currency, g_cur;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pa_currency_matches_group ON payment_allocations;
CREATE TRIGGER pa_currency_matches_group BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION _pa_currency_matches_group();

-- =====================================================================================
-- 3. payment_attempts: one immutable group, one row per Checkout Session attempt
--    (replaces "delete allocations on expiry" with atomic attempt expiry)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_group_id uuid NOT NULL REFERENCES payment_groups(id) ON DELETE RESTRICT,
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text,
  canonical_request_hash text NOT NULL,
  request_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','expired','paid','failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expired_at timestamptz,
  paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS payment_attempts_group_idx ON payment_attempts(payment_group_id);
-- at most one live attempt per group; a new Session is allowed only after the prior one durably expires
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_open ON payment_attempts(payment_group_id) WHERE status = 'open';

-- =====================================================================================
-- 4. refund_operations: stable parent op so a FAILED refund can spawn an authorized retry
-- =====================================================================================
CREATE TABLE IF NOT EXISTS refund_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  op_key text UNIQUE NOT NULL,                       -- stable "booking:action"; one parent per operation
  booking_id uuid NOT NULL,
  payment_allocation_id uuid NOT NULL REFERENCES payment_allocations(id) ON DELETE RESTRICT,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'usd',
  actor text, reason text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','succeeded','failed','canceled','requires_review')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_operations_alloc_idx ON refund_operations(payment_allocation_id);

-- =====================================================================================
-- 5. refund_requests: settlement legs, parent link, versioned attempts, lease, typed states
-- =====================================================================================
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS parent_operation_id uuid REFERENCES refund_operations(id) ON DELETE RESTRICT;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS attempt_version integer NOT NULL DEFAULT 1;
-- exact settlement leg targets (immutable expectations)
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS expected_customer_amount          integer;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS expected_transfer_reversal_amount integer;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS expected_fee_refund_amount        integer;
-- captured Stripe leg identifiers
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS stripe_transfer_reversal_id text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS stripe_fee_refund_id        text;
-- per-leg + overall settlement status
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS customer_refund_status  text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS transfer_reversal_status text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS fee_refund_status       text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_status       text NOT NULL DEFAULT 'not_required';
-- canonical request identity (assert retries reproduce the SAME Stripe request)
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS canonical_request_hash text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS request_schema_version integer NOT NULL DEFAULT 1;
-- worker lease + backoff
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS lease_owner      text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS next_attempt_at  timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS refund_transfer_reversal_uidx ON refund_requests(stripe_transfer_reversal_id) WHERE stripe_transfer_reversal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS refund_fee_refund_uidx        ON refund_requests(stripe_fee_refund_id)        WHERE stripe_fee_refund_id        IS NOT NULL;
-- one row per (operation, attempt); a failed attempt keeps its row, a replacement gets a new version
CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_op_attempt_uidx ON refund_requests(parent_operation_id, attempt_version) WHERE parent_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS refund_requests_due_idx ON refund_requests(next_attempt_at) WHERE status IN ('reserved','submitted','pending','requires_action','failed_retryable');

-- widen the status vocabulary: add typed retryable / terminal / action-required states.
-- (Old rows keep their status; the CHECK is replaced to allow the new values.)
DO $$ BEGIN
  ALTER TABLE refund_requests DROP CONSTRAINT IF EXISTS refund_requests_status_check;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_status_check
  CHECK (status IN ('requires_review','reserved','submitted','pending','requires_action',
                    'failed_retryable','failed_terminal','succeeded','failed','canceled'));

-- retire the old globally-unique op_key index on refund_requests: uniqueness now lives on the
-- parent refund_operations table, so a failed op can be replaced by a new versioned child request.
DROP INDEX IF EXISTS refund_requests_opkey_uidx;

-- =====================================================================================
-- 6. reconciliation_cases: durable operator incidents (frozen payment / failed refund /
--    settlement exception / unmatched refund / payment contradiction). Created in the SAME
--    transaction as the event that raises them; a count in a cron response is not an alert.
-- =====================================================================================
CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('frozen_payment','failed_refund','settlement_exception',
                                     'unmatched_refund','payment_contradiction','expiry_conflict')),
  payment_group_id uuid,
  refund_request_id uuid,
  refund_operation_id uuid,
  stripe_payment_intent_id text, stripe_charge_id text, stripe_refund_id text,
  amount integer, currency text,
  reason text NOT NULL,
  details jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ack','resolved')),
  resolved_by text, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reconciliation_cases_open_idx ON reconciliation_cases(status) WHERE status <> 'resolved';

-- =====================================================================================
-- 7. updated_at touches + RLS (service-role only, matching the rest of the ledger)
-- =====================================================================================
DROP TRIGGER IF EXISTS pa_attempts_touch ON payment_attempts;    CREATE TRIGGER pa_attempts_touch  BEFORE UPDATE ON payment_attempts     FOR EACH ROW EXECUTE FUNCTION _pl_touch();
DROP TRIGGER IF EXISTS refund_ops_touch  ON refund_operations;   CREATE TRIGGER refund_ops_touch   BEFORE UPDATE ON refund_operations    FOR EACH ROW EXECUTE FUNCTION _pl_touch();
DROP TRIGGER IF EXISTS recon_cases_touch ON reconciliation_cases;CREATE TRIGGER recon_cases_touch  BEFORE UPDATE ON reconciliation_cases FOR EACH ROW EXECUTE FUNCTION _pl_touch();

ALTER TABLE payment_attempts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_operations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_attempts, refund_operations, reconciliation_cases FROM anon, authenticated;

COMMIT;
