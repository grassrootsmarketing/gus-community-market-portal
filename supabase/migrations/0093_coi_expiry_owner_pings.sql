-- 0093_coi_expiry_owner_pings.sql
-- ============================================================================
-- Owner COI expiry pings (David, 2026-10-16): warn the operator BEFORE a brand's approved certificate
-- of insurance lapses, when that brand still has demos ahead of it.
--
-- The retailer admin already shows a plain "COI expires before this demo" badge on every upcoming demo
-- (2026-10-16). What was missing is any notice to the owner ahead of the lapse. This release adds ONE
-- email per brand at 30, 14 and 3 days before brands.default_coi_expires, for brands whose
-- coi_verification_status is 'approved' and that have at least one future confirmed or pending PAID
-- booking. Each email names the brand, the expiry date, the upcoming demos it covers (date and store)
-- and links to the owner panel's COI Review section.
--
-- Delivery reuses the notification outbox (0074) the way reminders do: the worker's sweep writes
-- notification_deliveries rows DIRECTLY (event_id NULL, kind 'coi_expiry_owner', recipient_kind 'owner',
-- offset_key 'd30' / 'd14' / 'd3', occurrence_key '<brand id>:<expiry date>'), under the idempotency key
--   dedupe_key = 'coi_expiry_owner:<brand id>:<expiry date>:d<offset>'
-- so a re-run never double-sends and a renewal (the expiry date moves later) produces a fresh set of
-- rows for the new date while the old date's rows are skipped at dispatch ('coi_renewed'). A row whose
-- due time is already past when it is first scheduled is recorded as skipped 'due_before_scheduling',
-- exactly like a reminder, so the first rollout never produces a backlog burst.
--
-- THE ONE SCHEMA CHANGE. A ping is brand-scoped (one brand, demos at any number of stores), so it has
-- no single retailer_id. 0074's notification_deliveries_retailer_for_demo CHECK allows a NULL
-- retailer_id only for the two COI decision kinds; it is re-declared here to admit 'coi_expiry_owner'.
-- No events row is written (there is no transition to record: the sweep derives the schedule from the
-- brand's current expiry), so notification_events and its kind CHECK are untouched.
-- Forward-only. Idempotent. No row rewrites, no table, no trigger, no function.
-- ============================================================================

ALTER TABLE public.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_retailer_for_demo;
ALTER TABLE public.notification_deliveries
  ADD CONSTRAINT notification_deliveries_retailer_for_demo
  CHECK (retailer_id IS NOT NULL OR kind IN ('coi_approved','coi_rejected','coi_expiry_owner'));

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'notification_deliveries_retailer_for_demo' AND conrelid = 'public.notification_deliveries'::regclass;
  IF v_def IS NULL THEN RAISE EXCEPTION '0093 postcondition: notification_deliveries_retailer_for_demo is absent'; END IF;
  IF position('coi_expiry_owner' IN v_def) = 0 THEN RAISE EXCEPTION '0093 postcondition: retailer_for_demo check lacks coi_expiry_owner'; END IF;
  IF position('coi_approved' IN v_def) = 0 OR position('coi_rejected' IN v_def) = 0 THEN RAISE EXCEPTION '0093 postcondition: retailer_for_demo check lost the COI decision kinds'; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'notification_deliveries_recipient_kind_check' AND conrelid = 'public.notification_deliveries'::regclass;
  IF v_def IS NULL OR position('owner' IN v_def) = 0 THEN RAISE EXCEPTION '0093 postcondition: deliveries recipient_kind check lacks owner (0080 missing?)'; END IF;
END $$;
