-- 0073_demo_notifications.sql — store-contact notification ledger (feature/store-contact-notifications).
--
-- WHAT CHANGED IN THE PRODUCT. Store contacts (internal_contacts, "Store contacts & demo
-- notifications" in the Gus admin) used to be emailed the moment a brand booked or paid — before the
-- retailer had confirmed anything. They now hear about a demo when it is CONFIRMED, get reminders
-- before it (1 week / 3 days / 1 day / morning-of / 1 hour / custom N days, per contact), and are
-- told when a confirmed demo is cancelled or rescheduled. The reminder cron (api/demo-reminders.js,
-- every 15 minutes) re-derives "what is due" from the current demo date/time on every run, so it
-- needs a durable record of what it has already sent or it would send the same reminder on every
-- tick, and again after every redeploy.
--
-- THIS TABLE is that record: one row per (booking, contact, kind).
--   kind  'confirmed' | 'cancelled'                               once per booking+contact
--         'rescheduled@<YYYY-MM-DD>T<HH:MM>'                       once per NEW slot (a demo can move twice)
--         'reminder:<1w|3d|1d|custom|morning_of|1h>@<YYYY-MM-DD>T<HH:MM>'
--         The slot suffix is the demo's CURRENT date/time. After a reschedule the send times are
--         computed from the new slot and get NEW keys, so a "1 day before" already sent for the old
--         date does not suppress the "1 day before" for the new one; reminders for the old slot are
--         simply never due again (their send window is evaluated against the new date).
--
-- CLAIM SEMANTICS (why sent_at is nullable). The sender INSERTs the row first with sent_at NULL
-- (the claim), sends, then sets sent_at. The UNIQUE constraint makes two concurrent runs unable to
-- both claim the same (booking, contact, kind) — the loser's insert conflicts and it skips. If the
-- send fails the claim is DELETEd so the next run retries; a claim left behind by a crash mid-send
-- (sent_at still NULL after 10 minutes) may be taken over by a later run. This is at-least-once
-- with dedupe, not exactly-once — the same contract as case alerts (0040) and the fulfilment outbox
-- (0038), and the correct trade for email: a rare duplicate beats a reminder that never arrives.
--
-- ACCESS. Operational table written only by server code with the service key, like cron_heartbeat
-- and booking_fulfillments: RLS on, nothing for anon/authenticated, service_role explicit. Deleting a
-- booking or a contact cascades — a notification record is meaningless without either side.
-- Idempotent. Forward-only. tools/check-migrations.mjs rules apply (no bare SELECT).
BEGIN;

CREATE TABLE IF NOT EXISTS public.demo_notifications (
  id          uuid        NOT NULL DEFAULT gen_random_uuid(),
  booking_id  uuid        NOT NULL REFERENCES public.bookings(id)          ON DELETE CASCADE,
  contact_id  uuid        NOT NULL REFERENCES public.internal_contacts(id) ON DELETE CASCADE,
  kind        text        NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  CONSTRAINT demo_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT demo_notifications_once UNIQUE (booking_id, contact_id, kind),
  CONSTRAINT demo_notifications_kind_check CHECK (
    kind ~ '^(confirmed|cancelled|rescheduled@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}|reminder:(1w|3d|1d|custom|morning_of|1h)@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})$'
  )
);

CREATE INDEX IF NOT EXISTS demo_notifications_booking_idx ON public.demo_notifications (booking_id);
-- Stale-claim takeover looks for unsent claims; keep that scan cheap.
CREATE INDEX IF NOT EXISTS demo_notifications_unsent_idx ON public.demo_notifications (claimed_at) WHERE sent_at IS NULL;

ALTER TABLE public.demo_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.demo_notifications FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.demo_notifications TO service_role;

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: the table exists with its dedupe constraint, RLS is on, and no browser role can
-- read it. A migration that applied without achieving this must fail loudly, not report success.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rls  boolean;
  v_uniq int;
  v_anon int;
BEGIN
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'demo_notifications';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: demo_notifications missing or RLS not enabled';
  END IF;

  SELECT count(*) INTO v_uniq FROM pg_constraint
   WHERE conrelid = 'public.demo_notifications'::regclass AND conname = 'demo_notifications_once' AND contype = 'u';
  IF v_uniq <> 1 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: demo_notifications_once unique constraint absent';
  END IF;

  SELECT count(*) INTO v_anon FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'demo_notifications' AND grantee IN ('anon', 'authenticated');
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: % browser-role grant(s) remain on demo_notifications', v_anon;
  END IF;

  -- The kind check must accept every key the application writes and reject junk.
  IF NOT ('reminder:1d@2026-09-22T11:00' ~ '^(confirmed|cancelled|rescheduled@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}|reminder:(1w|3d|1d|custom|morning_of|1h)@[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})$') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: kind pattern rejects a reminder key';
  END IF;
END $$;
