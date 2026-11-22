-- 0127_reservation_provider_deadline.sql (2026-11-22)
-- ============================================================================
-- Codex review of 3fc5c22 (verdict FIX), item 2: a client timeout is not provider completion.
-- Forward-only on top of 0123 to 0126 (applied on demohub-rebuild-check only, not rewritten). The production paste
-- carries 0123 to 0127 in ONE transaction.
--
-- What 0126 still claimed. A reserved attempt with no stored session was failed, and its capacity released, once the
-- quiescence point had passed and a search of the provider found no session for the group. The quiescence point
-- bounds when THIS handler may still SEND. It says nothing about how long the provider takes to finish a request it
-- received, or about a runtime that was suspended between the handler's clock check and its request. An empty search
-- is therefore not evidence that no session can appear later.
--
-- The correction. Every Checkout Session request built from now on carries an ABSOLUTE expires_at, and that same
-- instant is stored on the reservation (provider_expires_at) together with the request, write-once. This is the
-- provider's own rule, not a timer of ours: a session created from that request can only be paid until that instant,
-- whenever the provider processes it, and the provider refuses to create it at all once the instant is less than 30
-- minutes away. So for a reservation whose outcome is unknown:
--     found a session for the group  -> its outcome is settled with the provider as before (expired there, or it blocks)
--     found none                     -> the reservation stays BLOCKED until provider_expires_at plus a margin has passed.
--                                       Only then may it be failed, through fail_unresolved_reservation below, which
--                                       checks that instant itself under the attempt's row lock.
--     no provider_expires_at at all  -> a reservation made before this file. Nothing bounds it. It stays blocked,
--                                       scheduled fairly (0126) and reported, until a person resolves it. It is never
--                                       released on an empty search.
-- The attempt key and the stored request are unchanged; no replacement attempt is created while the outcome is open.
-- ============================================================================

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_expires_at timestamptz;

CREATE OR REPLACE FUNCTION unpaid_expiry_provider_margin_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 300 $$;

-- write-once, together with the request it belongs to
CREATE OR REPLACE FUNCTION payment_attempts_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_request IS NOT NULL THEN
    NEW.provider_request := OLD.provider_request;
    NEW.provider_request_version := OLD.provider_request_version;
    NEW.provider_expires_at := OLD.provider_expires_at;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payment_attempts_request_immutable ON payment_attempts;
CREATE TRIGGER trg_payment_attempts_request_immutable BEFORE UPDATE OF provider_request, provider_request_version, provider_expires_at ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_request_immutable();

DROP FUNCTION IF EXISTS reserve_payment_attempt(uuid, text, integer, text);

CREATE OR REPLACE FUNCTION reserve_payment_attempt(p_group_id uuid, p_hash text, p_schema integer, p_request text DEFAULT NULL, p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gstatus text; v_total int; v_sum int; v_live record; v_id uuid; v_gen int; v_started timestamptz; v_lease timestamptz;
BEGIN
  IF p_group_id IS NULL OR p_hash IS NULL OR btrim(p_hash) = '' THEN RAISE EXCEPTION 'group_and_hash_required'; END IF;
  SELECT status, total_customer_amount, unpaid_expiry_started_at INTO v_gstatus, v_total, v_started FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;
  -- 0123: once expiry has begun for this group, no attempt is created and no existing attempt is handed back
  IF v_started IS NOT NULL THEN RAISE EXCEPTION 'unpaid_expired group'; END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
             WHERE a.payment_group_id = p_group_id AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= now()) THEN
    RAISE EXCEPTION 'unpaid_expired group';
  END IF;
  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    -- the immutable request snapshot of the live attempt must be the one the caller computed; a different snapshot
    -- (the store's routing changed after the claim) is refused, never silently forked
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    -- 0125: the request this attempt was FIRST created with is handed back; the caller sends that, never a rebuilt one.
    -- NULL means a reservation made before 0125, whose original request the ledger never held.
    -- 0126: a caller that is handed a RESERVATION may send one provider request for it, and only inside this lease.
    -- The lease is written under the group lock, so expiry (which takes the same lock) either sees it or prevents it.
    IF v_live.status = 'reserved' THEN
      UPDATE payment_attempts SET create_lease_until = now() + make_interval(secs => unpaid_expiry_lease_seconds()) WHERE id = v_live.id
        RETURNING create_lease_until INTO v_lease;
    END IF;
    RETURN jsonb_build_object('outcome', v_live.status, 'attempt_id', v_live.id, 'generation', v_live.generation, 'lease_until', v_lease,
                              'session_id', v_live.stripe_checkout_session_id, 'existing', true,
                              'request', v_live.provider_request, 'request_version', v_live.provider_request_version,
                              'provider_expires_at', v_live.provider_expires_at);
  END IF;

  SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
  INSERT INTO payment_attempts(payment_group_id, canonical_request_hash, request_schema_version, status, generation, reserved_at, create_lease_until, provider_request, provider_request_version, provider_expires_at)
    VALUES (p_group_id, p_hash, coalesce(p_schema,1), 'reserved', v_gen, now(), now() + make_interval(secs => unpaid_expiry_lease_seconds()), nullif(p_request, ''), CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END,
            -- 0127: the provider-side deadline is only meaningful together with the stored request that carries it
            CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE p_expires_at END)
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'reserved', 'attempt_id', v_id, 'generation', v_gen, 'session_id', NULL, 'existing', false,
                            'lease_until', now() + make_interval(secs => unpaid_expiry_lease_seconds()),
                            'request', nullif(p_request, ''), 'request_version', CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END,
                            'provider_expires_at', CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE p_expires_at END);
END $$;

CREATE OR REPLACE FUNCTION begin_unpaid_group_expiry(p_group_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_att record; v_due int; v_t timestamptz := coalesce(p_now, now()); v_started timestamptz; v_q timestamptz;
BEGIN
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.unpaid_expired_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_expired'); END IF;
  -- a payment or an authorization that arrived first wins: nothing to expire
  IF v_g.status NOT IN ('pending','session_created') THEN
    -- the marker of an expiry that had begun is cleared, so the group is not offered to the worker again
    IF v_g.unpaid_expiry_started_at IS NOT NULL THEN
      UPDATE payment_groups SET unpaid_expiry_started_at = NULL, unpaid_expiry_next_check_at = NULL, unpaid_expiry_blocked_reason = NULL,
             unpaid_expiry_blocked_since = NULL, unpaid_expiry_blocked_count = 0 WHERE id = p_group_id;
    END IF;
    RETURN jsonb_build_object('outcome','not_open','status',v_g.status);
  END IF;
  IF v_g.unpaid_expiry_started_at IS NULL THEN
    SELECT count(*) INTO v_due FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
     WHERE a.payment_group_id = p_group_id AND b.payment_status = 'unpaid' AND b.status IN ('pending_payment','held')
       AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= v_t;
    IF v_due = 0 THEN RETURN jsonb_build_object('outcome','not_due'); END IF;
    UPDATE payment_groups SET unpaid_expiry_started_at = v_t WHERE id = p_group_id;
  END IF;
  v_started := coalesce(v_g.unpaid_expiry_started_at, v_t);
  SELECT * INTO v_att FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','expiring','live_attempt',NULL,'started_at',v_started,'quiescent',true); END IF;
  -- 0126 (R2): the point after which no checkout request can still be sending a provider request for this group.
  v_q := unpaid_expiry_quiescent_at(v_started, v_att.create_lease_until);
  RETURN jsonb_build_object('outcome','expiring','live_attempt', jsonb_build_object(
    'attempt_id', v_att.id, 'status', v_att.status, 'session_id', v_att.stripe_checkout_session_id,
    'generation', v_att.generation, 'reserved_at', v_att.reserved_at, 'created_at', v_att.created_at, 'create_lease_until', v_att.create_lease_until, 'provider_expires_at', v_att.provider_expires_at,
    'provider_window_closed', (v_att.provider_expires_at IS NOT NULL AND v_t >= v_att.provider_expires_at + make_interval(secs => unpaid_expiry_provider_margin_seconds())),
    'seconds_to_provider_window_close', CASE WHEN v_att.provider_expires_at IS NULL THEN NULL ELSE greatest(0, ceil(extract(epoch from (v_att.provider_expires_at + make_interval(secs => unpaid_expiry_provider_margin_seconds()) - v_t))))::int END),
    'started_at', v_started, 'quiescent_at', v_q, 'quiescent', v_t >= v_q, 'seconds_to_quiescent', greatest(0, ceil(extract(epoch from (v_q - v_t))))::int);
END $$;

-- The ONLY way a reservation with an unknown provider outcome and no session found is ended. Refused unless the
-- provider-side deadline of its stored request, plus the margin, has passed.
CREATE OR REPLACE FUNCTION fail_unresolved_reservation(p_attempt_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_t timestamptz := coalesce(p_now, now());
BEGIN
  SELECT * INTO v_att FROM payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_attempt'); END IF;
  IF v_att.status <> 'reserved' THEN RETURN jsonb_build_object('outcome','not_reserved','status',v_att.status); END IF;
  IF v_att.stripe_checkout_session_id IS NOT NULL THEN RETURN jsonb_build_object('outcome','has_session'); END IF;
  IF v_att.provider_expires_at IS NULL THEN RETURN jsonb_build_object('outcome','unbounded'); END IF;
  IF v_t < v_att.provider_expires_at + make_interval(secs => unpaid_expiry_provider_margin_seconds()) THEN
    RETURN jsonb_build_object('outcome','provider_window_open','provider_expires_at',v_att.provider_expires_at);
  END IF;
  UPDATE payment_attempts SET status = 'failed', last_error = 'unpaid_expired:provider_deadline_passed' WHERE id = p_attempt_id;
  RETURN jsonb_build_object('outcome','failed','attempt_id',p_attempt_id,'generation',v_att.generation);
END $$;

REVOKE ALL ON FUNCTION reserve_payment_attempt(uuid,text,integer,text,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fail_unresolved_reservation(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION payment_attempts_request_immutable() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_provider_margin_seconds() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt(uuid,text,integer,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION fail_unresolved_reservation(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_provider_margin_seconds() TO service_role;

DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_attempts' AND column_name='provider_expires_at';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_attempts.provider_expires_at missing'; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname IN ('reserve_payment_attempt','begin_unpaid_group_expiry','fail_unresolved_reservation');
  IF v_n <> 3 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: % functions for 3 names (a missing function or an extra overload)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='reserve_payment_attempt';
  IF position('provider_expires_at' in v_def) = 0 OR position('create_lease_until' in v_def) = 0 OR position('provider_request' in v_def) = 0 OR position('unpaid_expired' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: reserve_payment_attempt lacks the provider deadline or lost an earlier behaviour';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='fail_unresolved_reservation';
  IF position('unbounded' in v_def) = 0 OR position('provider_window_open' in v_def) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: fail_unresolved_reservation lacks its refusals'; END IF;
  IF has_function_privilege('anon', 'fail_unresolved_reservation(uuid,timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'reserve_payment_attempt(uuid,text,integer,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute a reservation function';
  END IF;
  RAISE NOTICE '0127: post-conditions passed';
END $$;
