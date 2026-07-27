-- 0034_refund_rpcs.sql — Codex reverify #10, Phase B + C: refund correctness + exact settlement.
-- Builds on 0032/0033. Never rewrites 0029–0031.
--
-- Fixes:
--   R10-P0-4  one canonical refund request; worker replay is byte-identical; adoption is an atomic
--             RPC (not a swallowed PATCH); leased worker with next_attempt_at + typed retry states.
--   R10-P0-5  refund events resolve by TRUSTED metadata request id (not refund-id-only), validate
--             request→allocation→group / PI / charge ownership, attach id null-or-same, persist
--             pending/requires_action, assert reservation on releasing transitions, quarantine only
--             a truly unknown refund, and open a case on contradiction.
--   R10-P0-6  destination-charge refunds settle EXACTLY per allocation via three independent legs
--             (customer refund / transfer reversal / application-fee refund), never proportionally.
--   R10-P0-7  a failed refund opens a durable case and can spawn an AUTHORIZED replacement attempt
--             (stable parent operation + versioned child requests), with truthful comms.
--   R10-P1-2/P1-3  refund initiation is one idempotent CAS command that returns the existing
--             request on retry instead of recomputing remaining.
BEGIN;

-- ------------------------------------------------------------------------------------
-- refund_reserve_cas: THE refund-initiation command. One transaction:
--   (optional) CAS the booking source status; create-or-return the parent operation; reserve the
--   exact allocation amount; snapshot the exact settlement legs; return everything the caller needs
--   to submit a canonical Stripe request. Idempotent on p_op_key.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refund_reserve_cas(
  p_booking_id uuid, p_op_key text, p_actor text, p_reason text,
  p_booking_expect text[] DEFAULT NULL, p_booking_set text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_alloc record; v_grp record; v_bk record; v_op record; v_req record;
  v_remaining int; v_fee_portion int; v_opid uuid; v_rid uuid; v_key text; v_keeps boolean;
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
        'expected_fee_refund_amount',v_req.expected_fee_refund_amount,'settlement_status',v_req.settlement_status);
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

  -- exact settlement legs (per THIS allocation; never proportional across the combined charge)
  v_fee_portion := round(v_alloc.platform_fee_amount::numeric * v_remaining / v_alloc.customer_amount)::int;

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
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version)
    VALUES (
      v_rid, v_opid, 1, v_alloc.id, p_booking_id, v_remaining, v_alloc.gcur,
      p_actor, p_reason, p_op_key, 'reserved', v_key, now(),
      v_remaining, CASE WHEN v_keeps THEN NULL ELSE v_remaining END, CASE WHEN v_keeps THEN NULL ELSE v_fee_portion END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_remaining || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1);

  RETURN jsonb_build_object('outcome','reserved','refund_request_id',v_rid,'refund_operation_id',v_opid,
    'idempotency_key',v_key,'payment_intent',v_alloc.pi,'charge_id',v_alloc.charge_id,
    'keeps_all',v_keeps,'connect_account_id',v_alloc.connect,'amount',v_remaining,
    'expected_customer_amount',v_remaining,
    'expected_transfer_reversal_amount', CASE WHEN v_keeps THEN NULL ELSE v_remaining END,
    'expected_fee_refund_amount', CASE WHEN v_keeps THEN NULL ELSE v_fee_portion END,
    'settlement_status', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END);
END $$;

-- ------------------------------------------------------------------------------------
-- apply_refund_event: converge a customer-refund Stripe event onto its request. Resolves by
-- trusted metadata request id first, else refund id. Validates ownership, attaches id null-or-same.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_refund_event(
  p_refund_id text, p_status text, p_amount integer, p_currency text,
  p_pi text, p_charge text, p_meta_request_id uuid, p_event_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_alloc record; v_grp record; v_all boolean; v_terminal boolean;
BEGIN
  IF p_meta_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM refund_requests WHERE id = p_meta_request_id FOR UPDATE;
  END IF;
  IF v_req.id IS NULL AND p_refund_id IS NOT NULL THEN
    SELECT * INTO v_req FROM refund_requests WHERE stripe_refund_id = p_refund_id FOR UPDATE;
  END IF;
  IF v_req.id IS NULL THEN RETURN jsonb_build_object('outcome','unmatched'); END IF;   -- caller quarantines

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.stripe_charge_id AS charge_id, g.id AS gid
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.id = v_req.payment_allocation_id FOR UPDATE;

  -- ownership: the event's PI/charge must match the request's group
  IF p_pi IS NOT NULL AND v_alloc.pi IS NOT NULL AND p_pi <> v_alloc.pi THEN
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, stripe_refund_id, reason, details)
      VALUES ('payment_contradiction', v_req.id, v_alloc.gid, p_refund_id, 'refund_pi_mismatch', jsonb_build_object('event_pi',p_pi,'group_pi',v_alloc.pi));
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch');
  END IF;
  IF p_charge IS NOT NULL AND v_alloc.charge_id IS NOT NULL AND p_charge <> v_alloc.charge_id THEN
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, stripe_refund_id, reason, details)
      VALUES ('payment_contradiction', v_req.id, v_alloc.gid, p_refund_id, 'refund_charge_mismatch', jsonb_build_object('event_charge',p_charge,'group_charge',v_alloc.charge_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch');
  END IF;
  -- amount/currency validation
  IF p_amount IS NOT NULL AND p_amount <> v_req.amount THEN RAISE EXCEPTION 'refund_amount_mismatch % <> %', p_amount, v_req.amount; END IF;
  IF p_currency IS NOT NULL AND lower(p_currency) <> lower(v_req.currency) THEN RAISE EXCEPTION 'refund_currency_mismatch'; END IF;
  -- attach refund id null-or-same
  IF v_req.stripe_refund_id IS NOT NULL AND p_refund_id IS NOT NULL AND v_req.stripe_refund_id <> p_refund_id THEN
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, stripe_refund_id, reason)
      VALUES ('payment_contradiction', v_req.id, v_alloc.gid, p_refund_id, 'refund_id_disagreement');
    RETURN jsonb_build_object('outcome','contradiction','reason','refund_id_disagreement');
  END IF;

  v_terminal := v_req.status IN ('succeeded','failed_terminal','failed','canceled');
  IF v_terminal THEN
    IF p_status = 'succeeded' AND v_req.status = 'succeeded' THEN RETURN jsonb_build_object('outcome','already_terminal'); END IF;
    IF (p_status IN ('failed','canceled') AND v_req.status IN ('failed','failed_terminal','canceled')) THEN RETURN jsonb_build_object('outcome','already_terminal'); END IF;
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, stripe_refund_id, reason, details)
      VALUES ('payment_contradiction', v_req.id, v_alloc.gid, p_refund_id, 'terminal_contradiction', jsonb_build_object('was',v_req.status,'got',p_status));
    RETURN jsonb_build_object('outcome','contradiction','reason','terminal_contradiction');
  END IF;

  IF v_req.stripe_refund_id IS NULL AND p_refund_id IS NOT NULL THEN
    UPDATE refund_requests SET stripe_refund_id = p_refund_id WHERE id = v_req.id;
  END IF;

  IF p_status = 'succeeded' THEN
    IF v_alloc.reserved_refund_amount < v_req.amount THEN RAISE EXCEPTION 'reservation_underflow'; END IF;
    UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount - v_req.amount,
                                   refunded_amount = refunded_amount + v_req.amount WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'succeeded', customer_refund_status = 'succeeded' WHERE id = v_req.id;
    UPDATE refund_operations SET status = 'succeeded' WHERE id = v_req.parent_operation_id;
    UPDATE bookings SET payment_status = CASE WHEN (v_alloc.refunded_amount + v_req.amount) >= v_alloc.customer_amount THEN 'refunded' ELSE 'partial_refund' END,
                        refund_id = coalesce(p_refund_id, v_req.stripe_refund_id), refunded_at = now() WHERE id = v_req.booking_id;
  ELSIF p_status IN ('failed','canceled') THEN
    UPDATE payment_allocations SET reserved_refund_amount = greatest(0, reserved_refund_amount - v_req.amount) WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'failed_terminal', customer_refund_status = p_status WHERE id = v_req.id;
    UPDATE refund_operations SET status = 'failed' WHERE id = v_req.parent_operation_id;
    INSERT INTO reconciliation_cases(kind, refund_request_id, refund_operation_id, payment_group_id, stripe_refund_id, amount, currency, reason)
      VALUES ('failed_refund', v_req.id, v_req.parent_operation_id, v_alloc.gid, p_refund_id, v_req.amount, v_req.currency, 'stripe_refund_'||p_status);
    RETURN jsonb_build_object('outcome','failed','request_id',v_req.id);
  ELSE
    UPDATE refund_requests SET status = CASE WHEN p_status='requires_action' THEN 'requires_action' ELSE 'pending' END,
                               customer_refund_status = p_status WHERE id = v_req.id;
    RETURN jsonb_build_object('outcome','pending_persisted','status',p_status);
  END IF;

  -- roll up group status
  SELECT bool_and(refunded_amount >= customer_amount) INTO v_all FROM payment_allocations WHERE payment_group_id = v_alloc.gid;
  UPDATE payment_groups SET status = CASE WHEN v_all THEN 'refunded'
      WHEN EXISTS (SELECT 1 FROM payment_allocations WHERE payment_group_id = v_alloc.gid AND refunded_amount > 0) THEN 'partially_refunded'
      ELSE status END
    WHERE id = v_alloc.gid AND status IN ('paid','partially_refunded');
  RETURN jsonb_build_object('outcome','applied','request_id',v_req.id,'status',p_status);
END $$;

-- ------------------------------------------------------------------------------------
-- record_settlement_leg: attach a Connect settlement leg (customer/transfer_reversal/fee_refund)
-- and recompute overall settlement_status; open a settlement_exception case on a failed leg.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_settlement_leg(
  p_request_id uuid, p_leg text, p_stripe_id text, p_status text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_cust text; v_tr text; v_fee text; v_done boolean; v_failed boolean;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;

  IF p_leg = 'customer' THEN
    UPDATE refund_requests SET customer_refund_status = p_status, stripe_refund_id = coalesce(stripe_refund_id, p_stripe_id) WHERE id = p_request_id;
  ELSIF p_leg = 'transfer_reversal' THEN
    UPDATE refund_requests SET transfer_reversal_status = p_status, stripe_transfer_reversal_id = coalesce(stripe_transfer_reversal_id, p_stripe_id) WHERE id = p_request_id;
  ELSIF p_leg = 'fee_refund' THEN
    UPDATE refund_requests SET fee_refund_status = p_status, stripe_fee_refund_id = coalesce(stripe_fee_refund_id, p_stripe_id) WHERE id = p_request_id;
  ELSE
    RAISE EXCEPTION 'unknown_leg %', p_leg;
  END IF;

  SELECT customer_refund_status, transfer_reversal_status, fee_refund_status INTO v_cust, v_tr, v_fee FROM refund_requests WHERE id = p_request_id;
  v_failed := (v_cust = 'failed' OR v_tr = 'failed' OR v_fee = 'failed');
  -- all three legs required for a destination-charge refund; keeps-all is 'not_required' and never here
  v_done := (v_cust = 'succeeded' AND v_tr = 'succeeded' AND v_fee = 'succeeded');

  IF v_failed THEN
    UPDATE refund_requests SET settlement_status = 'exception' WHERE id = p_request_id;
    INSERT INTO reconciliation_cases(kind, refund_request_id, payment_group_id, reason, details)
      SELECT 'settlement_exception', p_request_id, a.payment_group_id, 'settlement_leg_failed',
             jsonb_build_object('customer',v_cust,'transfer_reversal',v_tr,'fee_refund',v_fee)
      FROM payment_allocations a WHERE a.id = v_req.payment_allocation_id;
    RETURN jsonb_build_object('outcome','settlement_exception');
  ELSIF v_done THEN
    UPDATE refund_requests SET settlement_status = 'complete' WHERE id = p_request_id;
    RETURN jsonb_build_object('outcome','settlement_complete');
  END IF;
  RETURN jsonb_build_object('outcome','leg_recorded','settlement_status','pending');
END $$;

-- ------------------------------------------------------------------------------------
-- create_refund_replacement: authorized retry of a FAILED operation. New versioned request +
-- new idempotency key; re-reserves the amount. Requires the parent op to be failed.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_refund_replacement(p_op_key text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op record; v_alloc record; v_grp record; v_ver int; v_remaining int; v_rid uuid; v_key text; v_keeps boolean; v_fee int;
BEGIN
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_operation'); END IF;
  IF v_op.status <> 'failed' THEN RETURN jsonb_build_object('outcome','not_failed','status',v_op.status); END IF;

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.platform_keeps_all AS keeps, g.connect_account_id AS connect, g.currency AS gcur
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.id = v_op.payment_allocation_id FOR UPDATE;
  v_keeps := v_alloc.keeps;
  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF v_remaining <= 0 THEN RETURN jsonb_build_object('outcome','nothing_refundable'); END IF;
  v_fee := round(v_alloc.platform_fee_amount::numeric * v_remaining / v_alloc.customer_amount)::int;

  SELECT coalesce(max(attempt_version),1) + 1 INTO v_ver FROM refund_requests WHERE parent_operation_id = v_op.id;
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + v_remaining WHERE id = v_alloc.id;
  UPDATE refund_operations SET status = 'open' WHERE id = v_op.id;

  v_rid := gen_random_uuid(); v_key := 'rf-' || v_rid::text;
  INSERT INTO refund_requests(
      id, parent_operation_id, attempt_version, payment_allocation_id, booking_id, amount, currency,
      actor, reason, op_key, status, stripe_idempotency_key, next_attempt_at,
      expected_customer_amount, expected_transfer_reversal_amount, expected_fee_refund_amount,
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version)
    VALUES (v_rid, v_op.id, v_ver, v_alloc.id, v_op.booking_id, v_remaining, v_alloc.gcur,
      p_actor, 'authorized_replacement', p_op_key, 'reserved', v_key, now(),
      v_remaining, CASE WHEN v_keeps THEN NULL ELSE v_remaining END, CASE WHEN v_keeps THEN NULL ELSE v_fee END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_remaining || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1);

  RETURN jsonb_build_object('outcome','replacement_created','refund_request_id',v_rid,'refund_operation_id',v_op.id,
    'attempt_version',v_ver,'idempotency_key',v_key,'payment_intent',v_alloc.pi,'keeps_all',v_keeps,
    'connect_account_id',v_alloc.connect,'amount',v_remaining);
END $$;

-- ------------------------------------------------------------------------------------
-- claim_refund_work / release_refund_work: leased, backoff-aware worker queue. SKIP LOCKED so two
-- workers never take the same row; lease has an owner + expiry; release sets next_attempt_at.
-- ------------------------------------------------------------------------------------
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
              rr.settlement_status, rr.payment_allocation_id
  )
  SELECT coalesce(jsonb_agg(to_jsonb(leased)), '[]'::jsonb) INTO v_rows FROM leased;
  RETURN v_rows;
END $$;

CREATE OR REPLACE FUNCTION release_refund_work(
  p_request_id uuid, p_owner text, p_status text, p_next_attempt_at timestamptz, p_last_error text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE refund_requests
     SET status = coalesce(p_status, status),
         next_attempt_at = coalesce(p_next_attempt_at, next_attempt_at),
         last_error = coalesce(p_last_error, last_error),
         attempts = attempts + 1,
         lease_owner = NULL, lease_expires_at = NULL
   WHERE id = p_request_id AND lease_owner = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;   -- false => we lost the lease; caller must not treat its work as authoritative
END $$;

-- ---------- privileges: service_role only ----------
REVOKE ALL ON FUNCTION refund_reserve_cas(uuid,text,text,text,text[],text)               FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_refund_event(text,text,integer,text,text,text,uuid,text)     FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION record_settlement_leg(uuid,text,text,text)                         FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION create_refund_replacement(text,text)                               FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION claim_refund_work(text,integer,integer)                            FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION release_refund_work(uuid,text,text,timestamptz,text)               FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION refund_reserve_cas(uuid,text,text,text,text[],text)              TO service_role;
GRANT EXECUTE ON FUNCTION apply_refund_event(text,text,integer,text,text,text,uuid,text)    TO service_role;
GRANT EXECUTE ON FUNCTION record_settlement_leg(uuid,text,text,text)                        TO service_role;
GRANT EXECUTE ON FUNCTION create_refund_replacement(text,text)                              TO service_role;
GRANT EXECUTE ON FUNCTION claim_refund_work(text,integer,integer)                           TO service_role;
GRANT EXECUTE ON FUNCTION release_refund_work(uuid,text,text,timestamptz,text)              TO service_role;

COMMIT;
