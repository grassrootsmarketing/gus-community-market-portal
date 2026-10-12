-- 0091_payment_receipt_events.sql
-- ============================================================================
-- Payment receipts for brands (David, 2026-10-11, after Framani asked for receipts for the demo fee).
--
-- A brand that pays a demo fee gets ONE receipt email per payment, sent through the notification
-- outbox (0074) exactly the way the owner's "a brand booked" notice (0080) is: a durable event written
-- by a database trigger in the transaction that records the money, fanned out and delivered by the
-- worker with claim + lease, a recheck against the CURRENT ledger row at dispatch, a frozen payload
-- and a provider idempotency key before the first attempt, bounded retries. Nothing in the webhook
-- request path sends the receipt, so a crash after the ledger apply still produces the receipt later.
--
--   * ONE logical event per payment group: kind 'payment_receipt', transition_id = the payment group
--     id (UNIQUE (kind, transition_id) makes it idempotent across webhook replays). A hold that is
--     captured later is the same group reaching 'paid' once, so one receipt. A grouped checkout of
--     several demos is one payment and one receipt that lists every demo it covered.
--   * Eligibility comes from the VERIFIED ledger state: the event is written when payment_groups.status
--     first becomes 'paid' (apply_verified_payment, immediate charge or captured hold). An abandoned
--     or failed checkout writes nothing. Refunds do not write a second event.
--   * A brand can ask for the receipt again from the portal (Account tab). That request inserts a
--     second event with transition_id '<group id>:resend:<epoch ms>' from the application, which the
--     same fan-out and dispatch code serves; the application throttles repeats.
--   * retailer_id is carried on the event and the delivery (the 0074 CHECK constraints require it for
--     any kind that is not a COI decision); booking_id is NULL because the receipt is per payment.
-- Forward-only; 0074 and 0080 untouched (the events kind CHECK is re-declared to admit the new kind).
-- Idempotent. No row rewrites.
-- ============================================================================

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE public.notification_events
  ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected','owner_booking_created','payment_receipt'));

CREATE OR REPLACE FUNCTION public.payment_receipt_events() RETURNS trigger AS $$
DECLARE
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END;
BEGIN
  -- First time this payment group reaches 'paid'. A later refund (partially_refunded / refunded) is
  -- not a new payment and writes nothing; a group that was already settled never re-fires.
  IF NEW.status = 'paid' AND coalesce(v_old, '') NOT IN ('paid', 'partially_refunded', 'refunded') THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NEW.retailer_id, NULL, NEW.brand_id, 'payment_receipt', NEW.id::text,
            jsonb_build_object('payment_group_id', NEW.id, 'amount', NEW.total_customer_amount, 'currency', NEW.currency,
                               'stripe_charge_id', NEW.stripe_charge_id, 'stripe_payment_intent_id', NEW.stripe_payment_intent_id,
                               'paid_at', now()))
    ON CONFLICT (kind, transition_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_receipt_events ON public.payment_groups;
CREATE TRIGGER trg_payment_receipt_events
  AFTER INSERT OR UPDATE OF status ON public.payment_groups
  FOR EACH ROW EXECUTE FUNCTION public.payment_receipt_events();

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'notification_events_kind_check' AND conrelid = 'public.notification_events'::regclass;
  IF v_def IS NULL OR position('payment_receipt' IN v_def) = 0 THEN RAISE EXCEPTION '0091 postcondition: events kind check lacks payment_receipt'; END IF;
  IF position('owner_booking_created' IN v_def) = 0 THEN RAISE EXCEPTION '0091 postcondition: events kind check lost owner_booking_created'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_payment_receipt_events' AND tgrelid = 'public.payment_groups'::regclass) THEN
    RAISE EXCEPTION '0091 postcondition: trg_payment_receipt_events missing';
  END IF;
END $$;
