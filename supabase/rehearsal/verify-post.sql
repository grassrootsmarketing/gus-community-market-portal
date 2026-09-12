-- supabase/rehearsal/verify-post.sql — Codex Release B round 4, R4-04 (7): the UPGRADE REHEARSAL, step 4.
-- Runs on the disposable staging project after: reset to 0072 → seed-pre-0074.sql → `supabase migration up`
-- with 0073 still hidden (verify-ledger.sql proved the ledger tail). This file proves the UPGRADE PATH
-- itself, which a clean build cannot: pre-existing production-shaped rows survive 0074..0082 with their
-- snapshots, the outbox rows carry generation 1 and stay claimable, every audit is clean, and the
-- runtime contracts (claim/record fence, transition projection) behave on the upgraded data.
-- The DO block RAISEs on the first broken expectation; the SELECTs after it are the evidence listing.
DO $$
DECLARE r uuid; bk_paid uuid; bk_held uuid; n int; t text; c jsonb; tr record;
BEGIN
  SELECT id INTO r FROM retailers WHERE slug = 'rehearsal-market';
  IF r IS NULL THEN RAISE EXCEPTION 'rehearsal: the seeded retailer is missing after the upgrade'; END IF;

  -- ---- data preserved through 0074..0081 -------------------------------------------------------
  SELECT count(*) INTO n FROM bookings WHERE retailer_id = r;
  IF n <> 3 THEN RAISE EXCEPTION 'rehearsal: expected the 3 seeded bookings, found %', n; END IF;
  SELECT count(*) INTO n FROM bookings b WHERE b.retailer_id = r AND b.status = 'confirmed' AND b.payment_status = 'paid'
     AND EXISTS (SELECT 1 FROM demos d WHERE d.booking_id = b.id AND d.status = 'confirmed');
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the confirmed booking lost its linked demo'; END IF;
  SELECT id INTO bk_held FROM bookings WHERE retailer_id = r AND demo_date = date '2027-03-11' AND status = 'held' AND payment_status = 'authorized';
  IF bk_held IS NULL THEN RAISE EXCEPTION 'rehearsal: the held booking lost its authorization state'; END IF;
  -- a paid booking stays pending_payment until the outbox worker promotes it (promote_paid); at cutover that work is exactly what is in flight
  SELECT id INTO bk_paid FROM bookings WHERE retailer_id = r AND demo_date = date '2027-03-12' AND status = 'pending_payment' AND payment_status = 'paid';
  IF bk_paid IS NULL THEN RAISE EXCEPTION 'rehearsal: the paid booking awaiting confirmation lost its state'; END IF;
  -- Release A/B snapshots were stamped onto the pre-existing rows by the migrations themselves.
  -- (The first rehearsal run proved 0074/0075 skip held / pending_payment rows -> 0082 backfills every
  -- active row from its venue's slot configuration; HOURLY slots are 1 h, so every seeded row is 1 h.)
  SELECT count(*) INTO n FROM bookings WHERE retailer_id = r AND (start_at IS NULL OR end_at IS NULL OR timezone IS NULL OR duration_hours IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: % pre-existing booking(s) were not stamped with start_at/end_at/timezone/duration_hours', n; END IF;
  SELECT count(*) INTO n FROM bookings WHERE retailer_id = r AND (duration_hours <> 1 OR timezone <> 'America/Los_Angeles' OR end_at <> start_at + interval '1 hour');
  IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: % pre-existing booking(s) carry a duration/zone/end that does not match their 1 h slot (0082)', n; END IF;
  SELECT count(*) INTO n FROM bookings b WHERE b.retailer_id = r AND b.status IN ('held', 'pending_payment') AND b.start_at IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: % held / pending_payment row(s) still without a snapshot (0082 did not run?)', n; END IF;
  -- 0078 backfilled every existing outbox row to generation 1; still pending, still claimable
  SELECT count(*) INTO n FROM booking_fulfillments f JOIN bookings b ON b.id = f.booking_id WHERE b.retailer_id = r;
  IF n < 1 THEN RAISE EXCEPTION 'rehearsal: the seeded outbox rows are gone'; END IF;
  SELECT count(*) INTO n FROM booking_fulfillments f JOIN bookings b ON b.id = f.booking_id WHERE b.retailer_id = r
     AND NOT (f.status = 'pending' AND f.generation = 1 AND f.lease_owner IS NULL);
  IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: % outbox row(s) are not pending/generation 1/unleased after 0078', n; END IF;
  SELECT count(*) INTO n FROM booking_fulfillments WHERE booking_id = bk_paid AND status = 'pending' AND target_status = 'pending' AND generation = 1;
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the paid booking''s outbox row is not pending/target pending/generation 1'; END IF;
  SELECT count(*) INTO n FROM payment_groups WHERE retailer_id = r AND status IN ('authorized', 'paid');
  IF n <> 2 THEN RAISE EXCEPTION 'rehearsal: expected 2 ledger groups (authorized, paid), found %', n; END IF;
  SELECT count(*) INTO n FROM reconciliation_cases WHERE dedupe_key = 'rehearsal:case' AND resolved_at IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the open reconciliation case did not survive'; END IF;
  SELECT count(*) INTO n FROM processed_stripe_events WHERE event_id = 'evt_rehearsal_1';
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the processed Stripe event record did not survive'; END IF;

  -- ---- every audit clean on the upgraded data --------------------------------------------------
  SELECT count(*) INTO n FROM projection_anomalies(NULL);              IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: projection_anomalies reports % row(s)', n; END IF;
  SELECT count(*) INTO n FROM snapshot_drift(NULL);                    IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: snapshot_drift reports % row(s)', n; END IF;
  SELECT count(*) INTO n FROM schedule_mismatches();                   IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: schedule_mismatches reports % row(s)', n; END IF;
  SELECT count(*) INTO n FROM capacity_invariant_violations(NULL, true); IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: capacity_invariant_violations reports % row(s)', n; END IF;
  SELECT count(*) INTO n FROM offering_anomalies(NULL) WHERE class = 'invariant'; IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: offering_anomalies (invariant) reports % row(s)', n; END IF;

  -- ---- the contracts the new code depends on ---------------------------------------------------
  IF to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)') IS NOT NULL THEN RAISE EXCEPTION 'rehearsal: the six-argument complete_fulfillment must be gone (0078)'; END IF;
  IF to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text,integer)') IS NULL THEN RAISE EXCEPTION 'rehearsal: the generation-fenced complete_fulfillment is missing (0078)'; END IF;
  IF to_regprocedure('public.open_fulfillment_case(uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'rehearsal: the unguarded open_fulfillment_case must be gone (0081)'; END IF;
  IF to_regprocedure('public.record_fulfillment(uuid,text,integer,boolean,boolean,boolean,text,integer)') IS NULL THEN RAISE EXCEPTION 'rehearsal: record_fulfillment is missing (0081)'; END IF;
  IF to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)') IS NULL THEN RAISE EXCEPTION 'rehearsal: booking_transition is missing (0077)'; END IF;
  SELECT pg_get_function_arguments(oid) INTO t FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'venue_availability_apply_all';
  IF t IS NULL OR t NOT LIKE '%p_copy_slots boolean DEFAULT false%' THEN RAISE EXCEPTION 'rehearsal: venue_availability_apply_all must default p_copy_slots to false (0079): %', coalesce(t, '<missing>'); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_owner_booking_events') THEN RAISE EXCEPTION 'rehearsal: trg_owner_booking_events is missing (0080)'; END IF;

  -- ---- runtime contracts on the UPGRADED rows --------------------------------------------------
  c := record_fulfillment(bk_paid, 'nobody', 1, true, true, true, NULL, 6);
  IF c->>'outcome' <> 'stale' THEN RAISE EXCEPTION 'rehearsal: a claimless record must be a stale no-op, got %', c; END IF;
  c := claim_fulfillments('rehearsal-worker', 300, 10, NULL);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c, '[]'::jsonb)) e WHERE e->>'booking_id' = bk_paid::text AND (e->>'generation')::int = 1) THEN
    RAISE EXCEPTION 'rehearsal: claim_fulfillments must hand out the pre-upgrade row with generation 1, got %', c;
  END IF;
  -- the worker's own promotion on the upgraded row: pending_payment -> pending (0077 promote_paid), then the claim completes
  SELECT * INTO tr FROM booking_transition(bk_paid, r, 'promote_paid', '{"status":"pending"}'::jsonb, NULL);
  IF NOT tr.ok OR tr.status_after <> 'pending' THEN RAISE EXCEPTION 'rehearsal: promote_paid on the pre-upgrade row failed: % / %', tr.reason, tr.status_after; END IF;
  c := record_fulfillment(bk_paid, 'rehearsal-worker', 1, true, true, true, NULL, 6);
  IF c->>'outcome' <> 'done' THEN RAISE EXCEPTION 'rehearsal: the live claim must complete, got %', c; END IF;
  -- the retailer's confirm: pending -> confirmed with exactly one linked demo projected from the booking's snapshot
  SELECT * INTO tr FROM booking_transition(bk_paid, r, 'confirm', '{}'::jsonb, 30);
  IF NOT tr.ok OR tr.demo_id IS NULL THEN RAISE EXCEPTION 'rehearsal: booking_transition confirm failed: %', tr.reason; END IF;
  SELECT count(*) INTO n FROM demos WHERE booking_id = bk_paid AND status = 'confirmed';
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the transition must project exactly one linked demo, found %', n; END IF;
  SELECT count(*) INTO n FROM demos WHERE booking_id = bk_paid AND duration_hours = 1;
  IF n <> 1 THEN RAISE EXCEPTION 'rehearsal: the projected demo must carry the booking''s 1 h slot length, not the 3 h default (0082)'; END IF;
  SELECT count(*) INTO n FROM projection_anomalies(r); IF n <> 0 THEN RAISE EXCEPTION 'rehearsal: projection_anomalies after the transition: %', n; END IF;
  -- the held row's fence: an obsolete generation is refused even by the current lease holder
  c := record_fulfillment(bk_held, 'rehearsal-worker', 2, true, true, true, NULL, 6);
  IF c->>'outcome' <> 'stale' THEN RAISE EXCEPTION 'rehearsal: a wrong-generation record must be stale, got %', c; END IF;
  RAISE NOTICE 'rehearsal post-upgrade OK';
END $$;

SELECT 'bookings' AS k, status, payment_status, count(*) FROM bookings
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2, 3 ORDER BY 2, 3;
SELECT 'fulfillments' AS k, f.target_status, f.status, f.generation, count(*) FROM booking_fulfillments f JOIN bookings b ON b.id = f.booking_id
 WHERE b.retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2, 3, 4 ORDER BY 2, 3, 4;
SELECT 'attempts' AS k, a.stripe_payment_intent_id, a.status, g.status AS group_status FROM payment_attempts a JOIN payment_groups g ON g.id = a.payment_group_id
 WHERE g.retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') ORDER BY 2;
SELECT 'groups' AS k, status, count(*) FROM payment_groups
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2 ORDER BY 2;
SELECT 'demos' AS k, status, count(*) FROM demos
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2 ORDER BY 2;
