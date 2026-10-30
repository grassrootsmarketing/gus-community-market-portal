-- 0117_connected_settlement_exact.sql
-- ============================================================================
-- Exact, durable per-allocation settlement for connected (destination charge) refunds. Codex review of 8f43360,
-- 2026-10-30, items CC-1, CC-2 and CC-3. Forward-only, idempotent, additive columns only; no row is changed.
--
--   CC-1  Unequal-price carts: Stripe's refund_application_fee=true returns the application fee in proportion to the
--         WHOLE charge, while the ledger reserves per allocation. New connected refund requests carry
--         settlement_strategy 2: the customer refund and the transfer reversal stay at the booking's entitlement, and
--         the application fee refund is created SEPARATELY through the fee-refund API with an explicit integer amount
--         and its own durable idempotency key (fee_refund_idempotency_key, written at reservation, never changed).
--         The fee portion is defined on cumulative entitlement with cent rounding, so repeated partial refunds of one
--         allocation can never exceed its platform fee and the final remainder lands exactly; a zero portion is a
--         satisfied leg. Requests reserved before 0117 keep strategy 1 (the proportional flag was already sent under
--         their idempotency key; that payload is never changed).
--   CC-2  Settlement recovery independent of the customer leg: a leased settlement queue (claim_settlement_work /
--         release_settlement_work) over connected requests whose customer refund succeeded but whose settlement is not
--         complete, with attempts, backoff and lease expiry, plus settlement_mark_exception for stale or contradictory
--         requests (opens a deduplicated reconciliation case).
--   CC-3  Evidence is verified before it is recorded: record_settlement_leg now takes the verified amount and currency,
--         refuses a conflicting id (settlement_leg_conflict), a status regression (settlement_leg_regress) and an amount
--         or currency that differs from the request's expectation (settlement_leg_mismatch), accepts 'not_required'
--         for the fee leg only when the expected fee refund is zero, and completes a request only when every required
--         leg is recorded at its expected amount. apply_verified_payment gains the symmetric application-fee-id
--         contradiction (0116 checked the transfer id only). The old four-argument record_settlement_leg is dropped.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. columns
-- ---------------------------------------------------------------------------
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_strategy integer NOT NULL DEFAULT 1;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS fee_refund_idempotency_key text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS fee_refund_intent_at timestamptz;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS transfer_reversal_amount integer;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS fee_refund_amount integer;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_next_attempt_at timestamptz;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_lease_owner text;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_lease_expires_at timestamptz;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS settlement_last_error text;
CREATE UNIQUE INDEX IF NOT EXISTS refund_fee_refund_key_uidx ON refund_requests(fee_refund_idempotency_key) WHERE fee_refund_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS refund_settlement_pending_idx ON refund_requests(settlement_next_attempt_at) WHERE settlement_status = 'pending' AND status = 'succeeded';

-- ---------------------------------------------------------------------------
-- 2. reservation: strategy 2, fee idempotency key, cumulative fee rounding (0034 body otherwise verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refund_reserve_cas(
  p_booking_id uuid, p_op_key text, p_actor text, p_reason text,
  p_booking_expect text[] DEFAULT NULL, p_booking_set text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alloc record; v_grp record; v_bk record; v_op record; v_req record;
  v_remaining int; v_fee_portion int; v_opid uuid; v_rid uuid; v_key text; v_keeps boolean; v_fee_prior int; v_strategy int;
BEGIN
  -- lock booking (for the optional source-status CAS) and allocation/group
  SELECT * INTO v_bk FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_booking'); END IF;

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.stripe_charge_id AS charge_id,
         g.platform_keeps_all AS keeps, g.connect_account_id AS connect,
         g.stripe_transfer_id AS transfer_id, g.stripe_application_fee_id AS app_fee_id, g.currency AS gcur
    INTO v_alloc
    FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_allocation','requires_review',true); END IF;
  v_keeps := v_alloc.keeps;

  -- idempotent: an existing non-terminal operation for this op_key returns its latest request
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF FOUND AND v_op.status IN ('open','requires_review') THEN
    SELECT * INTO v_req FROM refund_requests WHERE parent_operation_id = v_op.id ORDER BY attempt_version DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('outcome','existing','refund_request_id',v_req.id,'refund_operation_id',v_op.id,
        'idempotency_key',v_req.stripe_idempotency_key,'payment_intent',v_alloc.pi,'charge_id',v_alloc.charge_id,
        'keeps_all',v_keeps,'connect_account_id',v_alloc.connect,'amount',v_req.amount,
        'expected_customer_amount',v_req.expected_customer_amount,
        'expected_transfer_reversal_amount',v_req.expected_transfer_reversal_amount,
        'expected_fee_refund_amount',v_req.expected_fee_refund_amount,'settlement_status',v_req.settlement_status,
        'settlement_strategy',v_req.settlement_strategy,'fee_refund_idempotency_key',v_req.fee_refund_idempotency_key);
    END IF;
  END IF;

  IF v_alloc.pi IS NULL THEN RETURN jsonb_build_object('outcome','not_charged','requires_review',true); END IF;

  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF v_remaining <= 0 THEN RETURN jsonb_build_object('outcome','nothing_refundable'); END IF;

  -- optional source-status CAS (P1-3): only transition the booking if it is in an expected state
  IF p_booking_expect IS NOT NULL THEN
    IF NOT (v_bk.status = ANY(p_booking_expect)) THEN
      RETURN jsonb_build_object('outcome','booking_state_conflict','status',v_bk.status);
    END IF;
    IF p_booking_set IS NOT NULL THEN UPDATE bookings SET status = p_booking_set WHERE id = p_booking_id; END IF;
  END IF;

  -- exact settlement legs (per THIS allocation; never proportional across the combined charge). 0117 (Codex CC-1):
  -- the fee portion is defined on CUMULATIVE entitlement, so repeated partial refunds of one allocation can never
  -- return more than the allocation's platform fee and the final remainder lands exactly: this request's fee refund
  -- is round(fee * (already refunded + reserved + this refund) / customer) minus the fee already expected by every
  -- live or succeeded request on this allocation. A zero result is a satisfied leg (no provider request).
  SELECT coalesce(sum(expected_fee_refund_amount),0) INTO v_fee_prior FROM refund_requests
    WHERE payment_allocation_id = v_alloc.id AND status NOT IN ('failed_terminal','failed','canceled');
  v_fee_portion := greatest(0, round(v_alloc.platform_fee_amount::numeric * (v_alloc.refunded_amount + v_alloc.reserved_refund_amount + v_remaining) / v_alloc.customer_amount)::int - v_fee_prior);
  -- 0117: new connected requests use settlement strategy 2 (explicit, allocation-derived application fee refund
  -- through the fee-refund API with its own durable idempotency key); keeps-all requests carry no strategy.
  v_strategy := CASE WHEN v_keeps THEN 1 ELSE 2 END;

  -- parent operation (stable) + reserve
  IF v_op.id IS NULL THEN
    INSERT INTO refund_operations(op_key, booking_id, payment_allocation_id, amount, currency, actor, reason, status)
      VALUES (p_op_key, p_booking_id, v_alloc.id, v_remaining, v_alloc.gcur, p_actor, p_reason, 'open')
      RETURNING id INTO v_opid;
  ELSE
    v_opid := v_op.id;
    UPDATE refund_operations SET status = 'open' WHERE id = v_opid AND status = 'requires_review';
  END IF;

  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + v_remaining WHERE id = v_alloc.id;

  v_rid := gen_random_uuid();
  v_key := 'rf-' || v_rid::text;    -- unique per attempt; safe to replay at Stripe
  INSERT INTO refund_requests(
      id, parent_operation_id, attempt_version, payment_allocation_id, booking_id, amount, currency,
      actor, reason, op_key, status, stripe_idempotency_key, next_attempt_at,
      expected_customer_amount, expected_transfer_reversal_amount, expected_fee_refund_amount,
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version,
      settlement_strategy, fee_refund_idempotency_key)
    VALUES (
      v_rid, v_opid, 1, v_alloc.id, p_booking_id, v_remaining, v_alloc.gcur,
      p_actor, p_reason, p_op_key, 'reserved', v_key, now(),
      v_remaining, CASE WHEN v_keeps THEN NULL ELSE v_remaining END, CASE WHEN v_keeps THEN NULL ELSE v_fee_portion END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_remaining || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1,
      v_strategy, CASE WHEN v_keeps THEN NULL ELSE 'fr-' || v_rid::text END);

  RETURN jsonb_build_object('outcome','reserved','refund_request_id',v_rid,'refund_operation_id',v_opid,
    'idempotency_key',v_key,'payment_intent',v_alloc.pi,'charge_id',v_alloc.charge_id,
    'keeps_all',v_keeps,'connect_account_id',v_alloc.connect,'amount',v_remaining,
    'expected_customer_amount',v_remaining,
    'expected_transfer_reversal_amount', CASE WHEN v_keeps THEN NULL ELSE v_remaining END,
    'expected_fee_refund_amount', CASE WHEN v_keeps THEN NULL ELSE v_fee_portion END,
    'settlement_status', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
    'settlement_strategy', v_strategy, 'fee_refund_idempotency_key', CASE WHEN v_keeps THEN NULL ELSE 'fr-' || v_rid::text END);
END $$;

-- ---------------------------------------------------------------------------
-- 3. replacement: the same (0036 body otherwise verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_refund_replacement(p_op_key text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op record; v_alloc record; v_ver int; v_remaining int; v_rid uuid; v_key text; v_keeps boolean; v_fee int; v_live int; v_fee_prior int;
BEGIN
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_operation'); END IF;
  IF v_op.status NOT IN ('failed','requires_review') THEN RETURN jsonb_build_object('outcome','not_replaceable','status',v_op.status); END IF;

  SELECT count(*) INTO v_live FROM refund_requests
    WHERE parent_operation_id = v_op.id AND status IN ('reserved','submitted','pending','requires_action','failed_retryable');
  IF v_live > 0 THEN RETURN jsonb_build_object('outcome','live_request_exists','live',v_live); END IF;

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.platform_keeps_all AS keeps, g.connect_account_id AS connect, g.currency AS gcur
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.id = v_op.payment_allocation_id FOR UPDATE;
  v_keeps := v_alloc.keeps;
  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF v_remaining <= 0 THEN RETURN jsonb_build_object('outcome','nothing_refundable'); END IF;
  -- 0117: cumulative fee entitlement (see refund_reserve_cas); the replaced attempt is terminal so it is excluded
  SELECT coalesce(sum(expected_fee_refund_amount),0) INTO v_fee_prior FROM refund_requests
    WHERE payment_allocation_id = v_alloc.id AND status NOT IN ('failed_terminal','failed','canceled');
  v_fee := greatest(0, round(v_alloc.platform_fee_amount::numeric * (v_alloc.refunded_amount + v_alloc.reserved_refund_amount + v_remaining) / v_alloc.customer_amount)::int - v_fee_prior);

  SELECT coalesce(max(attempt_version),1) + 1 INTO v_ver FROM refund_requests WHERE parent_operation_id = v_op.id;
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + v_remaining WHERE id = v_alloc.id;
  UPDATE refund_operations SET status = 'open' WHERE id = v_op.id;

  v_rid := gen_random_uuid(); v_key := 'rf-' || v_rid::text;
  INSERT INTO refund_requests(
      id, parent_operation_id, attempt_version, payment_allocation_id, booking_id, amount, currency,
      actor, reason, op_key, status, stripe_idempotency_key, next_attempt_at,
      expected_customer_amount, expected_transfer_reversal_amount, expected_fee_refund_amount,
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version,
      settlement_strategy, fee_refund_idempotency_key)
    VALUES (v_rid, v_op.id, v_ver, v_alloc.id, v_op.booking_id, v_remaining, v_alloc.gcur,
      p_actor, 'authorized_replacement', p_op_key, 'reserved', v_key, now(),
      v_remaining, CASE WHEN v_keeps THEN NULL ELSE v_remaining END, CASE WHEN v_keeps THEN NULL ELSE v_fee END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_remaining || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1,
      CASE WHEN v_keeps THEN 1 ELSE 2 END, CASE WHEN v_keeps THEN NULL ELSE 'fr-' || v_rid::text END);

  RETURN jsonb_build_object('outcome','replacement_created','refund_request_id',v_rid,'refund_operation_id',v_op.id,
    'attempt_version',v_ver,'idempotency_key',v_key,'payment_intent',v_alloc.pi,'keeps_all',v_keeps,'amount',v_remaining);
END $$;

-- ---------------------------------------------------------------------------
-- 4. the customer-leg worker lease returns the strategy and the fee key (0034 body otherwise verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_refund_work(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb;
BEGIN
  WITH due AS (
    SELECT rr.id FROM refund_requests rr
    WHERE rr.status IN ('reserved','submitted','pending','requires_action','failed_retryable')
      AND rr.next_attempt_at <= now()
      AND (rr.lease_expires_at IS NULL OR rr.lease_expires_at < now())
    ORDER BY rr.next_attempt_at ASC
    LIMIT greatest(1, coalesce(p_limit,25))
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE refund_requests rr SET lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds,120)))
    FROM due WHERE rr.id = due.id
    RETURNING rr.id, rr.booking_id, rr.amount, rr.currency, rr.status, rr.stripe_idempotency_key,
              rr.stripe_refund_id, rr.attempts, rr.created_at, rr.parent_operation_id,
              rr.expected_customer_amount, rr.expected_transfer_reversal_amount, rr.expected_fee_refund_amount,
              rr.settlement_status, rr.payment_allocation_id, rr.settlement_strategy, rr.fee_refund_idempotency_key
  )
  SELECT coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) INTO v_rows FROM leased;
  RETURN v_rows;
END $$;

-- ---------------------------------------------------------------------------
-- 5. settlement-only queue (CC-2): eligible on the customer leg having succeeded, never on its status alone
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_settlement_work(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_rows jsonb;
BEGIN
  WITH due AS (
    SELECT rr.id FROM refund_requests rr
    WHERE rr.status = 'succeeded' AND rr.customer_refund_status = 'succeeded'
      AND rr.settlement_status = 'pending'
      AND (rr.settlement_next_attempt_at IS NULL OR rr.settlement_next_attempt_at <= now())
      AND (rr.settlement_lease_expires_at IS NULL OR rr.settlement_lease_expires_at < now())
    ORDER BY coalesce(rr.settlement_next_attempt_at, rr.updated_at) ASC
    LIMIT greatest(1, coalesce(p_limit,25))
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE refund_requests rr
      SET settlement_lease_owner = p_owner,
          settlement_lease_expires_at = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds,120))),
          settlement_attempts = rr.settlement_attempts + 1
    FROM due WHERE rr.id = due.id
    RETURNING rr.id, rr.booking_id, rr.payment_allocation_id, rr.amount, rr.currency, rr.stripe_refund_id,
              rr.expected_transfer_reversal_amount, rr.expected_fee_refund_amount, rr.settlement_strategy,
              rr.fee_refund_idempotency_key, rr.fee_refund_intent_at, rr.stripe_transfer_reversal_id, rr.stripe_fee_refund_id,
              rr.settlement_attempts, rr.settlement_last_error, rr.created_at
  )
  SELECT coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) INTO v_rows FROM leased;
  RETURN v_rows;
END $$;

CREATE OR REPLACE FUNCTION release_settlement_work(p_request_id uuid, p_owner text, p_next_attempt_at timestamptz, p_last_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE refund_requests
     SET settlement_next_attempt_at = p_next_attempt_at,
         settlement_last_error = p_last_error,
         settlement_lease_owner = NULL, settlement_lease_expires_at = NULL
   WHERE id = p_request_id AND settlement_lease_owner = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

-- intent before the provider call (CC-1 #3): recorded once, under the request's row lock
CREATE OR REPLACE FUNCTION settlement_mark_fee_intent(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;
  IF v_req.fee_refund_idempotency_key IS NULL THEN RETURN jsonb_build_object('outcome','no_key'); END IF;
  IF v_req.fee_refund_intent_at IS NULL THEN
    UPDATE refund_requests SET fee_refund_intent_at = now() WHERE id = p_request_id;
    RETURN jsonb_build_object('outcome','intent_recorded','first',true,'key',v_req.fee_refund_idempotency_key);
  END IF;
  RETURN jsonb_build_object('outcome','intent_recorded','first',false,'key',v_req.fee_refund_idempotency_key,'intent_at',v_req.fee_refund_intent_at);
END $$;

-- a stale or contradictory settlement becomes a visible, deduplicated case; the request stops being claimed
CREATE OR REPLACE FUNCTION settlement_mark_exception(p_request_id uuid, p_reason text, p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_case uuid; v_gid uuid;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;
  SELECT payment_group_id INTO v_gid FROM payment_allocations WHERE id = v_req.payment_allocation_id;
  UPDATE refund_requests SET settlement_status = 'exception', settlement_last_error = left(coalesce(p_reason,'settlement_exception'), 200),
         settlement_lease_owner = NULL, settlement_lease_expires_at = NULL WHERE id = p_request_id;
  v_case := _open_case('settlement_exception', 'settlement:' || p_request_id::text, coalesce(p_reason,'settlement_exception'),
                       v_gid, p_request_id, v_req.parent_operation_id, NULL, NULL, NULL, v_req.stripe_refund_id,
                       v_req.amount, v_req.currency, coalesce(p_details, '{}'::jsonb));
  RETURN jsonb_build_object('outcome','exception','case_id',v_case,'refund_request_id',p_request_id);
END $$;

-- ---------------------------------------------------------------------------
-- 6. verified settlement legs (CC-3): amount and currency are part of the evidence; conflicts are refused
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_settlement_leg(uuid,text,text,text);
CREATE OR REPLACE FUNCTION record_settlement_leg(
  p_request_id uuid, p_leg text, p_stripe_id text, p_status text, p_amount integer, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_cust text; v_tr text; v_fee text; v_done boolean; v_failed boolean; v_tr_ok boolean; v_fee_ok boolean;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;
  IF v_req.settlement_status = 'not_required' THEN RETURN jsonb_build_object('outcome','not_required'); END IF;
  IF p_status NOT IN ('succeeded','failed','not_required','pending') THEN RAISE EXCEPTION 'settlement_leg_bad_status %', p_status; END IF;

  IF p_leg = 'customer' THEN
    IF v_req.stripe_refund_id IS NOT NULL AND p_stripe_id IS NOT NULL AND v_req.stripe_refund_id <> p_stripe_id THEN RAISE EXCEPTION 'settlement_leg_conflict customer'; END IF;
    IF v_req.customer_refund_status = 'succeeded' AND p_status <> 'succeeded' THEN RAISE EXCEPTION 'settlement_leg_regress customer'; END IF;
    IF p_status = 'succeeded' AND (p_amount IS DISTINCT FROM v_req.amount OR lower(coalesce(p_currency,'')) <> lower(v_req.currency)) THEN RAISE EXCEPTION 'settlement_leg_mismatch customer'; END IF;
    UPDATE refund_requests SET customer_refund_status = p_status, stripe_refund_id = coalesce(stripe_refund_id, p_stripe_id) WHERE id = p_request_id;
  ELSIF p_leg = 'transfer_reversal' THEN
    IF v_req.stripe_transfer_reversal_id IS NOT NULL AND p_stripe_id IS NOT NULL AND v_req.stripe_transfer_reversal_id <> p_stripe_id THEN RAISE EXCEPTION 'settlement_leg_conflict transfer_reversal'; END IF;
    IF v_req.transfer_reversal_status = 'succeeded' AND p_status <> 'succeeded' THEN RAISE EXCEPTION 'settlement_leg_regress transfer_reversal'; END IF;
    IF p_status = 'succeeded' THEN
      IF p_stripe_id IS NULL THEN RAISE EXCEPTION 'settlement_leg_mismatch transfer_reversal id'; END IF;
      IF p_amount IS DISTINCT FROM v_req.expected_transfer_reversal_amount OR lower(coalesce(p_currency,'')) <> lower(v_req.currency) THEN RAISE EXCEPTION 'settlement_leg_mismatch transfer_reversal'; END IF;
    END IF;
    UPDATE refund_requests SET transfer_reversal_status = p_status, stripe_transfer_reversal_id = coalesce(stripe_transfer_reversal_id, p_stripe_id),
           transfer_reversal_amount = CASE WHEN p_status = 'succeeded' THEN p_amount ELSE transfer_reversal_amount END WHERE id = p_request_id;
  ELSIF p_leg = 'fee_refund' THEN
    IF v_req.stripe_fee_refund_id IS NOT NULL AND p_stripe_id IS NOT NULL AND v_req.stripe_fee_refund_id <> p_stripe_id THEN RAISE EXCEPTION 'settlement_leg_conflict fee_refund'; END IF;
    IF v_req.fee_refund_status IN ('succeeded','not_required') AND p_status NOT IN ('succeeded','not_required') THEN RAISE EXCEPTION 'settlement_leg_regress fee_refund'; END IF;
    IF p_status = 'not_required' AND coalesce(v_req.expected_fee_refund_amount,0) <> 0 THEN RAISE EXCEPTION 'settlement_leg_mismatch fee_refund not_required'; END IF;
    IF p_status = 'succeeded' THEN
      IF p_stripe_id IS NULL THEN RAISE EXCEPTION 'settlement_leg_mismatch fee_refund id'; END IF;
      IF p_amount IS DISTINCT FROM v_req.expected_fee_refund_amount OR lower(coalesce(p_currency,'')) <> lower(v_req.currency) THEN RAISE EXCEPTION 'settlement_leg_mismatch fee_refund'; END IF;
    END IF;
    UPDATE refund_requests SET fee_refund_status = p_status, stripe_fee_refund_id = coalesce(stripe_fee_refund_id, p_stripe_id),
           fee_refund_amount = CASE WHEN p_status = 'succeeded' THEN p_amount WHEN p_status = 'not_required' THEN 0 ELSE fee_refund_amount END WHERE id = p_request_id;
  ELSE
    RAISE EXCEPTION 'unknown_leg %', p_leg;
  END IF;

  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id;
  v_cust := v_req.customer_refund_status; v_tr := v_req.transfer_reversal_status; v_fee := v_req.fee_refund_status;
  v_failed := (v_cust = 'failed' OR v_tr = 'failed' OR v_fee = 'failed');
  v_tr_ok := (v_tr = 'succeeded' AND v_req.transfer_reversal_amount = v_req.expected_transfer_reversal_amount);
  v_fee_ok := (v_fee = 'succeeded' AND v_req.fee_refund_amount = v_req.expected_fee_refund_amount)
           OR (v_fee = 'not_required' AND coalesce(v_req.expected_fee_refund_amount,0) = 0);
  v_done := (v_cust = 'succeeded' AND v_tr_ok AND v_fee_ok);

  IF v_failed THEN
    UPDATE refund_requests SET settlement_status = 'exception' WHERE id = p_request_id;
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, reason, details)
      SELECT 'settlement_exception', p_request_id, a.payment_group_id, 'settlement_leg_failed',
             jsonb_build_object('customer',v_cust,'transfer_reversal',v_tr,'fee_refund',v_fee)
      FROM payment_allocations a WHERE a.id = v_req.payment_allocation_id;
    RETURN jsonb_build_object('outcome','settlement_exception');
  ELSIF v_done THEN
    UPDATE refund_requests SET settlement_status = 'complete', settlement_lease_owner = NULL, settlement_lease_expires_at = NULL,
           settlement_next_attempt_at = NULL, settlement_last_error = NULL WHERE id = p_request_id AND settlement_status <> 'complete';
    RETURN jsonb_build_object('outcome','settlement_complete');
  END IF;
  RETURN jsonb_build_object('outcome','leg_recorded','settlement_status',v_req.settlement_status,'transfer_reversal_status',v_tr,'fee_refund_status',v_fee);
END $$;

-- ---------------------------------------------------------------------------
-- 7. apply_verified_payment: the symmetric application fee id contradiction (0116 body otherwise verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid; v_auto boolean; v_fee_sum int;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  IF p_payment_intent IS NULL OR p_charge IS NULL OR p_amount IS NULL OR p_currency IS NULL THEN
    v_case := _open_case('payment_contradiction','pi-missing:'||p_session_id,'missing_pi_charge_amount_or_currency',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;

  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id;
  IF NOT FOUND THEN
    v_case := _open_case('unknown_session','unknown-session:'||p_session_id,'paid_session_not_bound_to_any_attempt',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','unknown_session','session_id',p_session_id,'case_id',v_case);
  END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;

  IF p_amount <> v_grp.total_customer_amount THEN
    v_case := _open_case('payment_contradiction','amount:'||p_session_id,'amount_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('expected',v_grp.total_customer_amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF lower(p_currency) <> lower(v_grp.currency) THEN
    v_case := _open_case('payment_contradiction','currency:'||p_session_id,'currency_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.platform_keeps_all THEN
    -- keeps-all: NO Connect field may be present (0036 P0-3 #9, unchanged)
    IF p_connect_dest IS NOT NULL OR p_on_behalf_of IS NOT NULL OR p_application_fee IS NOT NULL
       OR p_transfer_id IS NOT NULL OR p_fee_id IS NOT NULL THEN
      v_case := _open_case('payment_contradiction','connect-on-keepsall:'||p_session_id,'unexpected_connect_fields_on_keeps_all',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                           jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'fee',p_application_fee,'transfer',p_transfer_id,'fee_id',p_fee_id));
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_fields','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  ELSE
    -- 0116: connected. The money routing Stripe reports must equal the immutable snapshot taken at claim time:
    -- the destination and the settlement merchant are the store's connected account, and the application fee is
    -- exactly the sum of the platform fee legs. The transfer id and application fee id are NOT required here:
    -- Stripe fills charge.transfer and charge.application_fee a moment after capture (rehearsed 2026-10-30: the
    -- checkout.session.completed retrieval can see them still empty), so they are recorded when present, write-once,
    -- and a later replay that carries them fills them in (the idempotent branch below).
    SELECT coalesce(sum(platform_fee_amount),0) INTO v_fee_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
    IF coalesce(v_grp.connect_account_id,'') = ''
       OR coalesce(p_connect_dest,'') <> v_grp.connect_account_id
       OR coalesce(p_on_behalf_of,'') <> v_grp.connect_account_id
       OR coalesce(p_application_fee,-1) <> v_fee_sum THEN
      v_case := _open_case('payment_contradiction','connect-routing:'||p_session_id,'connect_routing_mismatch',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                           jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'app_fee',p_application_fee,'transfer',p_transfer_id,'fee_id',p_fee_id,
                                              'expected_dest',v_grp.connect_account_id,'expected_fee',v_fee_sum));
      RETURN jsonb_build_object('outcome','contradiction','reason','connect_routing_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  END IF;

  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] an authorized group may already carry the UNCAPTURED charge id from auth time; capture re-delivers the
  -- same charge id, so equality holds.
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- 0116: the settlement identifiers are write-once as well
  IF v_grp.stripe_transfer_id IS NOT NULL AND p_transfer_id IS NOT NULL AND v_grp.stripe_transfer_id <> p_transfer_id THEN
    v_case := _open_case('payment_contradiction','transfer-mismatch:'||p_session_id,'transfer_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('recorded',v_grp.stripe_transfer_id,'got',p_transfer_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','transfer_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- 0117 (Codex CC-3): the application fee id is write-once too, symmetric with the transfer id
  IF v_grp.stripe_application_fee_id IS NOT NULL AND p_fee_id IS NOT NULL AND v_grp.stripe_application_fee_id <> p_fee_id THEN
    v_case := _open_case('payment_contradiction','fee-mismatch:'||p_session_id,'application_fee_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('recorded',v_grp.stripe_application_fee_id,'got',p_fee_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','application_fee_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    -- 0116: a replay of a connected payment that now carries the settlement ids fills them in, write-once (the
    -- routing above already matched the snapshot; a different transfer id was refused above).
    IF NOT v_grp.platform_keeps_all AND (v_grp.stripe_transfer_id IS NULL OR v_grp.stripe_application_fee_id IS NULL) THEN
      UPDATE payment_groups SET stripe_transfer_id = coalesce(stripe_transfer_id, p_transfer_id),
                                stripe_application_fee_id = coalesce(stripe_application_fee_id, p_fee_id) WHERE id = v_grp.id;
    END IF;
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'group_status',v_grp.status,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  -- [0065] (a) 'authorized' joins the payable set: capture is the second half of a manual-capture payment
  IF v_grp.status NOT IN ('pending','session_created','failed','authorized') THEN
    v_case := _open_case('payment_contradiction','status:'||p_session_id,'group_not_payable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] (c) an 'authorized' attempt is the expected pre-capture state
  IF v_att.status NOT IN ('open','authorized') THEN
    v_case := _open_case('payment_contradiction','attempt-not-open:'||p_session_id,'attempt_not_open',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('attempt_status',v_att.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','attempt_not_open','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  SELECT count(*), coalesce(sum(customer_amount),0) INTO v_alloc_count, v_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
  IF v_alloc_count = 0 OR v_sum <> v_grp.total_customer_amount THEN
    UPDATE payment_groups SET status = 'frozen' WHERE id = v_grp.id;
    v_case := _open_case('frozen_payment','sum:'||p_session_id,'allocation_sum_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'alloc_sum',v_sum,'group_total',v_grp.total_customer_amount));
    RETURN jsonb_build_object('outcome','frozen','reason','allocation_sum_mismatch','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  -- [0065] (b) flippable = normal unpaid checkout OR a held authorization being captured
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id
      AND ((b.payment_status = 'unpaid' AND b.status = 'pending_payment')
        OR (b.payment_status = 'authorized' AND b.status = 'held'));
  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen',
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
           stripe_charge_id = coalesce(stripe_charge_id, p_charge) WHERE id = v_grp.id;
    UPDATE payment_attempts SET status = 'failed', last_error = 'group_frozen_incomplete_apply' WHERE id = v_att.id;
    v_case := _open_case('frozen_payment','frozen:'||p_session_id,'captured_but_not_all_bookings_applyable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'flippable',v_flippable));
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  SELECT coalesce(r.auto_confirm_bookings,false) INTO v_auto FROM retailers r WHERE r.id = v_grp.retailer_id;

  UPDATE payment_groups SET status = 'paid',
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge),
      -- 0116: the settlement identifiers of a destination charge (NULL on a keeps-all group, refused above otherwise)
      stripe_transfer_id        = coalesce(stripe_transfer_id,        p_transfer_id),
      stripe_application_fee_id = coalesce(stripe_application_fee_id, p_fee_id)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE id = v_att.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  -- [0065] (d) a captured hold re-opens its 'held' outbox row with the real target (demo+emails);
  -- finished non-held rows keep their DO NOTHING replay-idempotency. [0078] C1: generation fencing.
  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END, 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO UPDATE
      SET target_status = EXCLUDED.target_status, status = 'pending',
          demo_created = false, emails_sent = false, completed_at = NULL, last_error = NULL,
          generation = booking_fulfillments.generation + 1,
          lease_owner = NULL, lease_expires_at = NULL, attempts = 0
      WHERE booking_fulfillments.target_status = 'held';

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status', CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END);
END $$;

REVOKE ALL ON FUNCTION refund_reserve_cas(uuid,text,text,text,text[],text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION create_refund_replacement(text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION claim_refund_work(text,integer,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION claim_settlement_work(text,integer,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION release_settlement_work(uuid,text,timestamptz,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION settlement_mark_fee_intent(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION settlement_mark_exception(uuid,text,jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION record_settlement_leg(uuid,text,text,text,integer,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION refund_reserve_cas(uuid,text,text,text,text[],text) TO service_role;
GRANT EXECUTE ON FUNCTION create_refund_replacement(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION claim_refund_work(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION claim_settlement_work(text,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION release_settlement_work(uuid,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION settlement_mark_fee_intent(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION settlement_mark_exception(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION record_settlement_leg(uuid,text,text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_apply text; v_reserve text;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public' AND table_name='refund_requests'
    AND column_name IN ('settlement_strategy','fee_refund_idempotency_key','fee_refund_intent_at','transfer_reversal_amount','fee_refund_amount','settlement_attempts','settlement_next_attempt_at','settlement_lease_owner','settlement_lease_expires_at','settlement_last_error');
  IF v_n <> 10 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: refund_requests settlement columns: % of 10', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public'
    AND p.proname IN ('claim_settlement_work','release_settlement_work','settlement_mark_fee_intent','settlement_mark_exception');
  IF v_n <> 4 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: settlement queue functions: % of 4', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='record_settlement_leg';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: record_settlement_leg overloads: % (expected the six-argument one only)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_apply FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='apply_verified_payment';
  IF position('fee-mismatch' in v_apply) = 0 OR position('connect-routing' in v_apply) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: apply_verified_payment lacks the fee id contradiction or the routing check'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_reserve FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='refund_reserve_cas';
  IF position('fee_refund_idempotency_key' in v_reserve) = 0 OR position('v_fee_prior' in v_reserve) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: refund_reserve_cas lacks the strategy 2 fields'; END IF;
  RAISE NOTICE '0117: post-conditions passed';
END $$;
