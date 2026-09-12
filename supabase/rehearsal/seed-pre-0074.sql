-- supabase/rehearsal/seed-pre-0074.sql — Codex Release B round 4, R4-04 (7): the UPGRADE REHEARSAL, step 2.
-- Representative, production-shaped data written on the 0072 schema (production's), BEFORE 0074..0081
-- are applied. Uses only columns that exist at 0072 and the SAME ledger RPCs the product uses, so the
-- rows are exactly what the migrations will meet in production:
--   (1) a confirmed booking with its linked calendar demo           (the steady state)
--   (2) a held booking with a LIVE authorization + its outbox row    (a brand mid-hold at cutover)
--   (3) a PAID booking awaiting manual confirmation + outbox row     (undrained work at cutover)
--   (4) an open reconciliation case, (5) a processed Stripe event, (6) a cron heartbeat
-- Staging only; the CI job resets the project afterwards. Never run against production.
DO $$
DECLARE r uuid; v uuid; b uuid; bk_conf uuid; bk_held uuid; bk_paid uuid; g_held uuid; g_paid uuid; j jsonb; c uuid;
BEGIN
  INSERT INTO retailers (slug, name, billing_email, platform_keeps_all, auto_confirm_bookings)
    VALUES ('rehearsal-market', 'Rehearsal Market', 'rehearsal-market@fixture.test', true, false) RETURNING id INTO r;
  INSERT INTO venues (retailer_id, name, address, demo_fee, availability) VALUES (r, 'Rehearsal Main', '1 Rehearsal Way', 30,
    '{"schedule":{"0":[{"open":"05:00","close":"23:00"}],"1":[{"open":"05:00","close":"23:00"}],"2":[{"open":"05:00","close":"23:00"}],"3":[{"open":"05:00","close":"23:00"}],"4":[{"open":"05:00","close":"23:00"}],"5":[{"open":"05:00","close":"23:00"}],"6":[{"open":"05:00","close":"23:00"}]},"slots":[{"start":"06:00","hours":1},{"start":"07:00","hours":1},{"start":"08:00","hours":1},{"start":"09:00","hours":1},{"start":"10:00","hours":1},{"start":"11:00","hours":1},{"start":"12:00","hours":1},{"start":"13:00","hours":1},{"start":"14:00","hours":1},{"start":"15:00","hours":1},{"start":"16:00","hours":1},{"start":"17:00","hours":1},{"start":"18:00","hours":1},{"start":"19:00","hours":1},{"start":"20:00","hours":1},{"start":"21:00","hours":1}],"blackouts":[]}'::jsonb)
    RETURNING id INTO v;
  INSERT INTO brands (email, company_name) VALUES ('rehearsal-brand@fixture.test', 'Rehearsal Brand Co') RETURNING id INTO b;

  -- (1) confirmed + linked demo
  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
    VALUES (r, v, b, 'Rehearsal Brand Co', 'Rehearsal Rep', 'rehearsal-brand@fixture.test', 'Samples', date '2027-03-10', '10:00', 'confirmed', 'paid') RETURNING id INTO bk_conf;
  INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at, booking_id)
    VALUES (r, v, b, 'Rehearsal Brand Co', 'Rehearsal Rep', 'rehearsal-brand@fixture.test', date '2027-03-10', '10:00', 1, 'confirmed', now(), bk_conf);

  -- (2) held booking with a live authorization, through the product's own ledger RPCs (0065)
  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
    VALUES (r, v, b, 'Rehearsal Brand Co', 'Rehearsal Rep', 'rehearsal-brand@fixture.test', 'Samples', date '2027-03-11', '11:00', 'held', 'unpaid') RETURNING id INTO bk_held;
  SELECT payment_group_id INTO g_held FROM checkout_claim_group(b, r, ARRAY[bk_held], true, NULL, 0);
  PERFORM register_payment_attempt(g_held, 'cs_rehearsal_held', 'pi_rehearsal_held', 'h-rehearsal-held', 1);
  j := apply_verified_authorization('cs_rehearsal_held', 'pi_rehearsal_held', 'ch_rehearsal_held', 3000, 'usd');
  IF j->>'outcome' <> 'applied' THEN RAISE EXCEPTION 'seed: the authorization was not applied: %', j; END IF;

  -- (3) paid booking awaiting manual confirmation: outbox row pending, deliberately NOT drained
  INSERT INTO bookings (retailer_id, venue_id, brand_id, brand_name, contact_name, contact_email, product, demo_date, demo_time, status, payment_status)
    VALUES (r, v, b, 'Rehearsal Brand Co', 'Rehearsal Rep', 'rehearsal-brand@fixture.test', 'Samples', date '2027-03-12', '12:00', 'pending_payment', 'unpaid') RETURNING id INTO bk_paid;
  SELECT payment_group_id INTO g_paid FROM checkout_claim_group(b, r, ARRAY[bk_paid], true, NULL, 0);
  PERFORM register_payment_attempt(g_paid, 'cs_rehearsal_paid', 'pi_rehearsal_paid', 'h-rehearsal-paid', 1);
  j := apply_verified_payment('cs_rehearsal_paid', 'pi_rehearsal_paid', 'ch_rehearsal_paid', 3000, 'usd', NULL, NULL, NULL, NULL, NULL);
  IF j->>'outcome' <> 'applied' THEN RAISE EXCEPTION 'seed: the payment was not applied: %', j; END IF;

  -- (4) (5) (6)
  c := _open_case('settlement_exception', 'rehearsal:case', 'rehearsal_open_case', g_paid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"rehearsal":true}'::jsonb);
  INSERT INTO processed_stripe_events (event_id, event_type) VALUES ('evt_rehearsal_1', 'payment_intent.succeeded');
  INSERT INTO cron_heartbeat (cron_name, outcome, duration_ms, summary) VALUES ('provisional-sweep', 'ok', 12, '{"rehearsal":true}'::jsonb);
  RAISE NOTICE 'seed OK: retailer %, held group %, paid group %, case %', r, g_held, g_paid, c;
END $$;

-- the starting snapshot (evidence)
SELECT 'bookings' AS k, status, payment_status, count(*) FROM bookings
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2, 3 ORDER BY 2, 3;
SELECT 'fulfillments' AS k, f.target_status, f.status, f.attempts, count(*) FROM booking_fulfillments f JOIN bookings b ON b.id = f.booking_id
 WHERE b.retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2, 3, 4 ORDER BY 2, 3, 4;
SELECT 'groups' AS k, status, count(*) FROM payment_groups
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2 ORDER BY 2;
SELECT 'demos' AS k, status, count(*) FROM demos
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'rehearsal-market') GROUP BY 2 ORDER BY 2;
