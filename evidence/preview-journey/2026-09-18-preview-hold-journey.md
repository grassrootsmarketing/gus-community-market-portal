```
# Deployed-preview hold journey — 2026-09-18T10:53:50.026Z
preview: https://demohub-git-feature-release-b-slo-8760f9-grms-projects-0d18c653.vercel.app

— 0: the deployment under test —
  ok   operator probe: env=preview, binding valid, Stripe TEST mode, email SINK, database expected = staging
  ok   flags = the approved launch configuration (holds ON, checkout ON, notification worker ON, slot editing OFF)
  deployed commit 84e8fc44a4690f7d345b9b734145fd6262a893b5 (feature/release-b-slots-blackouts)
  ok   the preview is NOT publicly reachable without the protection bypass (Vercel Authentication)
  ok   /gussmarket -> 307 -> /r/gus on the candidate build
  ok   public status: database check green through the publishable key
  same-origin guard accepts Origin https://www.demohubhq.com (probe answered 401)
  ok   same-origin guard: the deployment accepts exactly its configured SITE_ORIGIN and refuses others
  ok   a cross-origin mutation is refused by the deployed CSRF guard

— 1: fixtures (test database) and sessions (deployed verify routes) —
  ok   owner session minted by the DEPLOYED owner-verify route
  ok   [manual] retailer session minted by the DEPLOYED admin-auth verify route
  ok   [auto] retailer session minted by the DEPLOYED admin-auth verify route
  ok   [manual] brand session minted by the DEPLOYED brand-account verify route
  ok   [auto] brand session minted by the DEPLOYED brand-account verify route
  ok   [release] brand session minted by the DEPLOYED brand-account verify route
  ok   [expiry] brand session minted by the DEPLOYED brand-account verify route
  ok   [error] brand session minted by the DEPLOYED brand-account verify route

— 2: brand profile / agreement / booking page smoke on the deployment —
  ok   brand profile-update through the deployed route
  ok   brand dashboard data loads with the session cookie (and reflects the update)
  ok   the same call without a session is refused
  ok   agreement-list answers for the brand
  ok   the booking page is served by the candidate build and carries the agreement modal

— 3: authorization + MANUAL capture (retailer confirms after COI approval) —
  ok   [manual] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)
  ok   [manual] the booking is 'held' with a 24h window before any payment
  ok   [manual] /api/checkout returns a REAL cs_test_ session
  ok   [manual] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN
  ok   [manual] hosted checkout completed on Stripe
  ok   [manual] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)
  ok   [manual] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded
  ok   [manual] the held-stage fulfilment completed on the deployment and the hold notice is FROZEN in the outbox (0083)
  ok   [manual] mail containment: the frozen message is addressed to the brand, the deployment is in SINK mode (redirected to the allowlist — see the MAIL log lines)

— 3b: frozen message is REUSED after the live context changes (Codex F-1, deployed) —
  (test manipulation, disclosed: the completed outbox row was reset to pending to simulate a lost completion record; generation unchanged)
  ok   [manual] two OVERLAPPING worker invocations both answer 200
  ok   [manual] the retry completed and the stored message is BYTE-IDENTICAL (old contact name, same frozen_at) — the renamed contact did not leak into the retry
  ok   [manual] overlap produced exactly one completion (attempts did not run away, no fulfilment case)
  ok   [manual] retailer confirm BEFORE COI approval is refused (coi_pending) and nothing is captured
  ok   [manual] COI upload through the deployed route (lands pending)
  ok   [manual] the owner queue on the preview lists the pending certificate
  ok   [manual] owner approves through the deployed route
  ok   [manual] approval attempted NO capture (manual-confirm retailer: the response carries no capture block, or captured_holds 0)
  ok   [manual] approval alone does NOT capture for a manual-confirm retailer
  ok   [manual] retailer confirm now CAPTURES (200)
  ok   [manual] Stripe: PI succeeded, $5.00 received
  ok   [manual] ledger paid, booking confirmed/paid, fulfilment re-issued as generation 2 and done, held-stage frozen entry kept, no case
  ok   [manual] exactly one demo projected for the confirmed booking

— 4: webhook replay and forgery against the deployment —
  ok   the real checkout.session.completed event for the manual hold exists at Stripe
  ok   REPLAY of the already-processed event (correctly signed) is acknowledged 200
  ok   …and changes NOTHING in the ledger, booking, outbox or cases
  ok   the same body with a WRONG signature is refused (400)
  ok   the event inbox holds exactly one row for that event

— 5: AUTOMATIC capture (auto-confirm retailer: COI approval completes the pair) —
  ok   [auto] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)
  ok   [auto] the booking is 'held' with a 24h window before any payment
  ok   [auto] /api/checkout returns a REAL cs_test_ session
  ok   [auto] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN
  ok   [auto] hosted checkout completed on Stripe
  ok   [auto] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)
  ok   [auto] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded
  ok   [auto] COI upload through the deployed route (lands pending)
  ok   [auto] the owner queue on the preview lists the pending certificate
  ok   [auto] owner approves through the deployed route
  ok   [auto] approval response reports captured_holds = 1 with per-hold outcomes (P-3 contract)
  ok   [auto] the per-hold outcome is captured + applied, no case
  ok   [auto] Stripe PI succeeded ($5.00) and the ledger is paid, booking confirmed

— 6: RELEASE (retailer declines a held booking: $0, no charge) —
  ok   [release] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)
  ok   [release] the booking is 'held' with a 24h window before any payment
  ok   [release] /api/checkout returns a REAL cs_test_ session
  ok   [release] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN
  ok   [release] hosted checkout completed on Stripe
  ok   [release] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)
  ok   [release] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded
  ok   [release] decline through the deployed route succeeds
  ok   [release] Stripe: PI canceled, nothing received
  ok   [release] ledger auth_canceled, booking declined, no refund rows, no case

— 7: EXPIRY (24h window elapsed) with two OVERLAPPING sweeps —
  ok   [expiry] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)
  ok   [expiry] the booking is 'held' with a 24h window before any payment
  ok   [expiry] /api/checkout returns a REAL cs_test_ session
  ok   [expiry] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN
  ok   [expiry] hosted checkout completed on Stripe
  ok   [expiry] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)
  ok   [expiry] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded
  (test manipulation, disclosed: held_expires_at moved one minute into the past)
  ok   [expiry] of two OVERLAPPING sweeps exactly ONE released the hold; the other released nothing (it either found no work, or Stripe's own PaymentIntent lock refused its cancel and it reported partial_failure without changing state)
  sweep A: {"ok":false,"scanned":1,"released":0,"expired_unpaid":0,"skipped_covered":0,"skipped_in_checkout":0,"errors":1,"error":"partial_failure","first_error":"release: stripe_cancel_failed: There is currently another in-progres
  sweep B: {"ok":true,"scanned":1,"released":1,"expired_unpaid":0,"skipped_covered":0,"skipped_in_checkout":0,"errors":0}
  ok   [expiry] Stripe: PI canceled exactly once, nothing received
  ok   [expiry] ledger auth_canceled, booking expired, no case from the overlap
  ok   [expiry] the NEXT sweep is clean (200, nothing left to release, no errors) — the refused overlap left no residue
  ok   the sweep endpoint refuses a caller without the cron secret (401)

— 8: truthful payment-outcome reporting when the capture cannot happen —
  ok   [error] /api/book on the preview accepts a brand WITHOUT a COI (provisional hold)
  ok   [error] the booking is 'held' with a 24h window before any payment
  ok   [error] /api/checkout returns a REAL cs_test_ session
  ok   [error] Stripe session is $5.00, mode=payment, and its success_url is built from the deployment's SITE_ORIGIN
  ok   [error] hosted checkout completed on Stripe
  ok   [error] the PaymentIntent is MANUAL capture and AUTHORIZED, not charged (requires_capture, amount_received 0)
  ok   [error] STRIPE'S OWN WEBHOOK reached the preview: group 'authorized', booking held/authorized, PI recorded
  ok   [error] COI upload through the deployed route (lands pending)
  ok   [error] the owner queue on the preview lists the pending certificate
  ok   [error] owner approves through the deployed route
  ok   [error] approval attempted NO capture (manual-confirm retailer: the response carries no capture block, or captured_holds 0)
  ok   [error] out-of-band: the authorization is cancelled directly at Stripe (simulates an expired/voided auth)
  confirm answered 502: {"ok":false,"action":"confirm","booking_id":"0c239cdb-699e-44bc-9894-30b15492c62a","error":"capture_failed","captured":false,"stage":"verify","pi_status":"canceled","message":"Stripe could not capture the held payment (pi_state_canceled). The authorization may have expired — nothing was charged."}
  ok   [error] the deployed route does NOT claim success and does NOT answer a generic 500: it reports a specific, truthful outcome (capture_failed "nothing was charged" after retrieving the PI, or a refusal because the hold was already released by Stripe's cancel webhook)
  ok   [error] ground truth: PI canceled, $0 received; the ledger converged to auth_canceled and the booking is NOT confirmed/paid

— 9: notification worker on the deployment (two overlapping ticks) —
  ok   both overlapping notification-worker ticks answer 200
  tick A: {"ok":true,"now":"2026-09-18T10:55:25.140Z","errors":0,"first_error":null,"fanout":{"events":10,"deliveries":2,"skipped_events":3,"errors":0},"schedule":{"bookings":1,"contacts":0,"rows_pending":0,"rows_skipped":0,"unresolvable":0,"truncate
  tick B: {"ok":true,"now":"2026-09-18T10:55:25.150Z","errors":0,"first_error":null,"fanout":{"events":10,"deliveries":5,"skipped_events":3,"errors":0},"schedule":{"bookings":1,"contacts":0,"rows_pending":0,"rows_skipped":0,"unresolvable":0,"truncate
  ok   confirmed bookings produced store-contact notification events, and every delivery is settled exactly once (accepted / skipped — none stuck, none duplicated)
  ok   the deployment wrote succeeded heartbeats for refund-worker, provisional-sweep and notification-worker

— 10: database audits after the journey —
  ok   projection_anomalies() = 0 rows
  ok   snapshot_drift() = 0 rows
  ok   offering_anomalies() class='invariant' = 0 rows
  ok   schedule_mismatches() = 0 rows
  ok   no open reconciliation case was produced by any journey booking

teardown: fixtures removed

preview hold journey: 104 passed, 0 failed
```

## Ids

```json
{
 "ids": {},
 "scenarios": {
  "manual": {
   "id": "9d6785e0-de2c-4a51-b655-8a3ea0b4ec9b",
   "gid": "7063c06e-c242-4ec5-8fce-60b24220fc6f",
   "sid": "cs_test_a1z6sFStIUe7BGyaWGsqA7ip26A51rbpsNjdyz7L4M3lOUmlcbL8K1LDNI",
   "piId": "pi_3UGzQhA6b3orPg0T08wUqljv"
  },
  "auto": {
   "id": "5a024a19-9318-4769-b70b-e3073faf4bd5",
   "gid": "aa00b91d-ff5c-4fed-8934-8b6d01e20911",
   "sid": "cs_test_a1KBMapJLwSYzHYQ5Hdg6m4sg8zRGCDp0HkL4IyJO8uf5JD6d0KT8vIyGP",
   "piId": "pi_3UGzR4A6b3orPg0T0qDZZlew"
  },
  "release": {
   "id": "9c3d5e4e-3d14-4e55-94ac-69f9c48cd4dc",
   "gid": "60e270da-3261-49c1-a877-4e1b525077ac",
   "sid": "cs_test_a1wDk75GpOcbxVvNKC4uwOsV2Q5FxgsG74r5duZ7rVX0ixtmuRRIABZK9w",
   "piId": "pi_3UGzRKA6b3orPg0T0XV6BEhI"
  },
  "expiry": {
   "id": "05432754-49b5-4e36-a420-430392d3954d",
   "gid": "55e47ede-64ec-4ff4-9bdb-3015b10585e6",
   "sid": "cs_test_a1EZJD0a0fiLtgzvDy3KHUEz35icetI5YUV2hLR7WWkYcWI1Yq8ZsiPZwE",
   "piId": "pi_3UGzRYA6b3orPg0T04HiW5rN"
  },
  "error": {
   "id": "0c239cdb-699e-44bc-9894-30b15492c62a",
   "gid": "66db2521-1f28-46ea-af73-dd3c5a9d6a89",
   "sid": "cs_test_a1qhst3zkGXcxKKhdKc5CwQVUP5NLLXeWQARK6fThXnh9wTW5cAr45VCl7",
   "piId": "pi_3UGzRnA6b3orPg0T1wglQIc8"
  }
 },
 "deployment": {
  "commit": "84e8fc44a4690f7d345b9b734145fd6262a893b5",
  "branch": "feature/release-b-slots-blackouts",
  "env": "preview",
  "binding": {
   "target": "preview",
   "project_ref_fingerprint": "tile…",
   "db_environment_expected": "staging",
   "stripe_mode": "test",
   "email_mode": "sink",
   "email_allowlist_count": 2,
   "has_publishable_key": true,
   "has_webhook_secret": true
  },
  "flags": {
   "provisionalHolds": true,
   "publicRetailerSignup": false,
   "coiAiVerification": false,
   "checkoutEnabled": true,
   "coiUploadEnabled": true,
   "brandInviteEnabled": false,
   "slotEditing": false,
   "notificationWorker": true,
   "coiAutoEnforcementFlag": false,
   "coiEnforcementModeRaw": "live",
   "coiEnforcementEffective": "off",
   "connectedCheckout": "hard_disabled",
   "max_cart": 10
  }
 },
 "sweep_overlap": {
  "a": {
   "status": 500,
   "body": {
    "ok": false,
    "scanned": 1,
    "released": 0,
    "expired_unpaid": 0,
    "skipped_covered": 0,
    "skipped_in_checkout": 0,
    "errors": 1,
    "error": "partial_failure",
    "first_error": "release: stripe_cancel_failed: There is currently another in-progress request using this Idempotent Key (that probably means you submitted twice, and the other request is still going through): pcx-pi_"
   }
  },
  "b": {
   "status": 200,
   "body": {
    "ok": true,
    "scanned": 1,
    "released": 1,
    "expired_unpaid": 0,
    "skipped_covered": 0,
    "skipped_in_checkout": 0,
    "errors": 0
   }
  }
 }
}
```
