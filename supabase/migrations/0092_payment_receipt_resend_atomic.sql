-- 0092_payment_receipt_resend_atomic.sql
-- ============================================================================
-- Codex receipts review PR-4 and PR-6 (2026-10-11): a brand's "email me this receipt again" request is ONE
-- atomic database operation, and the copy is addressed to the requesting contact only.
--
-- Before: the application read recent resend events, then inserted one. Overlapping requests all passed
-- the read and each inserted an event, each fanning out to every account contact. The disabled button
-- was the only limit.
--
-- Now: request_payment_receipt_resend() does, under a transaction-scoped advisory lock on the payment
-- group, the ownership check (the group belongs to the brand), the settlement check (paid, or paid then
-- refunded), the requester resolution (the session email must be the brand's account email or one of its
-- brand_members rows; the matching recipient id is recorded so fan-out can address that contact alone),
-- the rolling cooldown check on DATABASE time (the newest resend event for this group inside p_cooldown
-- seconds wins), and the insert. Concurrent callers serialize on the lock: exactly one inserts, the rest
-- see the fresh event and answer 'throttled' with the seconds left. A failed insert raises, so no caller
-- is told "queued" without a row.
--
-- The function is SECURITY DEFINER so it can read brands / brand_members / payment_groups and write
-- notification_events under its owner's rights, and EXECUTE is revoked from public, anon and
-- authenticated: only the service role (the API) may call it. Every caller still passes the brand id it
-- authenticated, and the function refuses any group that brand does not own.
-- Forward-only. Idempotent. No row rewrites.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.request_payment_receipt_resend(
  p_group_id uuid, p_brand_id uuid, p_requested_by text, p_cooldown_seconds integer DEFAULT 600
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_grp record;
  v_brand record;
  v_member record;
  v_recipient_id uuid;
  v_recipient_email text;
  v_last timestamptz;
  v_wait integer;
  v_now timestamptz := now();
  v_cooldown interval := make_interval(secs => greatest(coalesce(p_cooldown_seconds, 600), 1));
  v_event_id uuid;
  v_email text := lower(trim(coalesce(p_requested_by, '')));
BEGIN
  IF p_group_id IS NULL OR p_brand_id IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  -- Serialize every request for this group. Transaction-scoped: released at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('payment_receipt_resend:' || p_group_id::text));

  SELECT id, brand_id, retailer_id, status INTO v_grp FROM payment_groups WHERE id = p_group_id AND brand_id = p_brand_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_grp.status NOT IN ('paid', 'partially_refunded', 'refunded') THEN
    RETURN jsonb_build_object('outcome', 'not_settled', 'status', v_grp.status);
  END IF;

  -- The requester must be a current account contact of this brand: the account email, or a member.
  SELECT id, email INTO v_brand FROM brands WHERE id = p_brand_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_email <> '' AND lower(trim(coalesce(v_brand.email, ''))) = v_email THEN
    v_recipient_id := v_brand.id; v_recipient_email := v_brand.email;
  ELSE
    SELECT id, email INTO v_member FROM brand_members WHERE brand_id = p_brand_id AND lower(trim(email)) = v_email ORDER BY created_at ASC LIMIT 1;
    IF FOUND THEN v_recipient_id := v_member.id; v_recipient_email := v_member.email;
    ELSE RETURN jsonb_build_object('outcome', 'requester_not_a_contact'); END IF;
  END IF;

  -- Rolling cooldown on database time, resend events only (the automatic receipt never counts).
  SELECT max(created_at) INTO v_last FROM notification_events
   WHERE kind = 'payment_receipt' AND transition_id LIKE p_group_id::text || ':resend:%' AND created_at > v_now - v_cooldown;
  IF v_last IS NOT NULL THEN
    v_wait := greatest(1, ceil(extract(epoch FROM (v_last + v_cooldown - v_now)))::integer);
    RETURN jsonb_build_object('outcome', 'throttled', 'retry_after_seconds', v_wait);
  END IF;

  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_grp.retailer_id, NULL, v_grp.brand_id, 'payment_receipt',
          p_group_id::text || ':resend:' || (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text,
          jsonb_build_object('payment_group_id', p_group_id, 'resend', true,
                             'requested_by', v_recipient_email, 'requested_recipient_id', v_recipient_id, 'requested_at', v_now))
  RETURNING id INTO v_event_id;
  RETURN jsonb_build_object('outcome', 'queued', 'event_id', v_event_id, 'to', v_recipient_email, 'recipient_id', v_recipient_id);
END $$;

REVOKE ALL ON FUNCTION public.request_payment_receipt_resend(uuid, uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_payment_receipt_resend(uuid, uuid, text, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'request_payment_receipt_resend' AND p.prosecdef) THEN
    RAISE EXCEPTION '0092 postcondition: request_payment_receipt_resend missing or not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.request_payment_receipt_resend(uuid, uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0092 postcondition: anon can execute request_payment_receipt_resend';
  END IF;
  IF has_function_privilege('authenticated', 'public.request_payment_receipt_resend(uuid, uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0092 postcondition: authenticated can execute request_payment_receipt_resend';
  END IF;
END $$;
