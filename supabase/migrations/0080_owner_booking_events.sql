-- 0080_owner_booking_events.sql
-- Codex production-hotfix review (2026-09-12), H2: the owner's "a brand actually booked" notice gets its
-- own DURABLE identity in the notification outbox (0074) instead of riding the payment fulfilment's
-- brand-mail flag.
--
--   * ONE logical event per booking: kind 'owner_booking_created', transition_id = the booking id
--     (UNIQUE (kind, transition_id) makes it idempotent). A hold that is later captured is the SAME
--     booking event, never a second one. A grouped checkout yields one event per child booking.
--   * Eligibility comes from VERIFIED payment state, not from /api/book: the event is written by a
--     trigger when bookings.payment_status first becomes 'authorized' (hold) or 'paid' (capture /
--     ordinary payment) — i.e. from apply_verified_authorization / apply_verified_payment — so a
--     missed fan-out is recoverable from durable booking state, and an abandoned checkout writes nothing.
--   * Delivery uses the existing outbox machinery unchanged: claim + lease, recheck against CURRENT
--     booking facts at dispatch (hold vs paid wording decided then), frozen payload + provider
--     idempotency key before the first attempt, bounded send, backoff, unknown/expired-window handling.
--     The recipient kind 'owner' addresses the fixed operator address (api/_owner-alerts.js).
-- Forward-only; 0074 untouched (CHECK constraints are re-declared to admit the new kind/recipient).

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE public.notification_events
  ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected','owner_booking_created'));

ALTER TABLE public.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_recipient_kind_check;
ALTER TABLE public.notification_deliveries
  ADD CONSTRAINT notification_deliveries_recipient_kind_check
  CHECK (recipient_kind IN ('store_contact','brand','owner'));

CREATE OR REPLACE FUNCTION public.owner_booking_events() RETURNS trigger AS $$
DECLARE
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.payment_status ELSE NULL END;
BEGIN
  -- First verified money state for this booking: 'authorized' (hold placed) or 'paid' (captured or
  -- paid outright). Later transitions (authorized -> paid, refunds) do not create another event.
  IF NEW.payment_status IN ('authorized', 'paid') AND coalesce(v_old, '') NOT IN ('authorized', 'paid') THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NEW.retailer_id, NEW.id, NEW.brand_id, 'owner_booking_created', NEW.id::text,
            jsonb_build_object('payment_status', NEW.payment_status, 'status', NEW.status,
                               'demo_date', NEW.demo_date, 'demo_time', NEW.demo_time, 'venue_id', NEW.venue_id))
    ON CONFLICT (kind, transition_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owner_booking_events ON public.bookings;
CREATE TRIGGER trg_owner_booking_events
  AFTER INSERT OR UPDATE OF payment_status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.owner_booking_events();

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'notification_events_kind_check' AND conrelid = 'public.notification_events'::regclass;
  IF v_def IS NULL OR position('owner_booking_created' IN v_def) = 0 THEN RAISE EXCEPTION '0080 postcondition: events kind check lacks owner_booking_created'; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'notification_deliveries_recipient_kind_check' AND conrelid = 'public.notification_deliveries'::regclass;
  IF v_def IS NULL OR position('owner' IN v_def) = 0 THEN RAISE EXCEPTION '0080 postcondition: deliveries recipient_kind check lacks owner'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_owner_booking_events' AND tgrelid = 'public.bookings'::regclass) THEN
    RAISE EXCEPTION '0080 postcondition: trg_owner_booking_events missing';
  END IF;
END $$;
