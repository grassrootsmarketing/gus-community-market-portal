# Retailer demo moves: closure for Codex C1 .. C4 (revision 2)

Date: 2026-10-16. Branch `feat/retailer-demo-move`. Input: Demohub-Demo-Move-Closure-Response-2026-10-16.md (candidate a6b89ee). Tested release SHA: see the last section.

Request: a focused recheck of C1 to C4 only. Creation stays OFF (`RETAILER_MOVES_ENABLED` unset) on Production; nothing is merged to main; no production write, email or refund was made.

Migration immutability: 0094 (sha256 616817418c9e374548104bfcf6c29e0e173d122349410b0fd201c03517b4c91b) and 0095 (0fdca9472b4e2fadbacb17e22da8424a6532efae4a4a9a698edfecae974139fe) are unchanged from the versions applied to demohub-rebuild-check. The database corrections are in the new forward migration `0096_retailer_demo_move_finalizer_invariants.sql` (a5a54c6716ef8738fe513672475aa3507dbe6200ec12a1844b3b0ba0884dbd7a), applied to demohub-rebuild-check after 0095 with its ledger row. The production paste is now ONE transaction applying 0094, 0095, 0096 (`Documents/Codex/cutover-kit/0094-0096-retailer-demo-move-paste.sql`, manifest `MANIFEST-0094-0096.json`); the earlier 0094 and 0094+0095 kits were withdrawn. The guard additionally checks `reconciliation_cases.dedupe_key`, `payment_allocations.reserved_refund_amount`, `_open_case` and `get_deployment_identity`.

## C1 (P1): no completion without the persisted financial handoff

Implementation. api/_booking-moves.js: `openCase` returns `{ id }` or `{ error }` and never swallows; every review branch of `refundStep` (paid without a payment intent, no allocation, not charged, request missing, request foreign, request parked) calls `review()`, which returns `review_required` ONLY with a persisted `move_refund:<move id>` case id and otherwise returns `retry` with the case error, so `settleMove` records the failure (`finalize_move_settlement` with `p_settled=false`: attempts + 1, last error, lease released) and the move stays in the sweep. The refund handoff case is kept in `booking_moves.refund_case_id`, separate from the settlement-error case (`reconciliation_case_id`); a pre-existing transition-error case is never reused as the refund handoff. 0096 `finalize_move_settlement` enforces the invariant in the database before any write: the booking must be in an inactive state; the refund status must be one of six known words; submitted / succeeded / pending_worker require a `refund_requests` row of THIS booking; review_required requires a `reconciliation_cases` row whose `dedupe_key` is exactly `move_refund:<move id>`; not_paid requires a fee-waived or never-charged booking; already_refunded requires a refunded booking, a succeeded request, or an allocation with nothing left to refund. Every refusal returns a reason and writes nothing; the lease stays with the caller.

Evidence. Offline (tests/demo_move_offline.test.mjs, "Codex C1"): case service 500 / malformed / timeout for paid-without-intent: not finalized, no event, booking untouched, attempts + 1, retryable; recovery on the next attempt yields exactly one move_refund case, finalized with it, one event naming it; no-allocation with the case service down: not finalized, zero provider calls; request missing plus failed case write: not finalized; a pre-existing transition-error case is not reused. Database (tests/demo_move.test.mjs, "Codex C1"), calling the real finalizer directly on a claimed move: booking still active -> `booking_still_active`; review_required without a case -> `case_required`; with the transition-error case -> `case_invalid`; submitted with a nonexistent request -> `request_invalid`; not_paid on a paid booking -> `not_paid_inconsistent`; unknown word -> `refund_status_unknown`; in every refusal nothing is stamped and no event exists; with the real move_refund case: finalized once, event written naming the case, the booking's pending settlement cleared. Worker verdict: a failed settlement is counted (`failed`), so the run is 'failed' (500), never green.

## C2: parking and notice-scan failures are failures

Implementation. api/_booking-moves.js `sweepMoves`: a failed case creation while parking counts as `failed` with a diagnostic naming the move; the case-link write is awaited and `parked` is incremented only after it succeeds (a failed link is `failed`). The notice scan is driven by pending moves (not by terminal delivery rows): moves older than the two-hour grace period with no notice case, ordered `notice_checked_at` nulls first then `moved_at`, bounded by the batch, and every examined move is stamped `notice_checked_at`, so later moves are always reached. `noticeUndeliverable` distinguishes retryable from terminal: a delivery that is accepted, pending, claimed, or failed/unknown WITH a retry scheduled keeps the notice alive; only a set with no live delivery (or no delivery at all after the grace period) is undeliverable. The case is linked on the move (`notice_case_id`). Any notice query, case, link or stamp failure sets `notice_failed`; api/refund-worker.js includes `moves_notice_failed` in the run verdict.

Evidence. Offline ("Codex C2"): case service unavailable while parking: failed 1, parked 0; link write fails: failed 1, parked 0; notice query fails: notice_failed; malformed notice results: notice_failed; undeliverable notice whose case cannot be opened: notice_failed and examined again next sweep; thirty previously examined old moves plus one new: batch of five, the new one first, case opened; `noticeUndeliverable` table (retry scheduled = alive; none = terminal; accepted = alive; no rows inside the grace period = alive, after it = terminal). Database: the refund worker route reports `moves_notice_checked` and runs clean with the switch off.

## C3: the refund amount is normalised once and never omitted

Implementation. api/_booking-refund.js `normalizeMinorUnits`: an integer number or a string of digits becomes a positive safe integer; null, zero, negative, fractional, nonfinite, unsafe and other strings are rejected. `reserveAndRefund` normalises the reservation's amount once, refuses `reserve_malformed` with zero provider calls otherwise, and passes the normalised number with `requireAmount: true`; `refundPaymentIntent` refuses `amount_invalid` before any provider call when an amount is required. The amount-less form (Stripe refunds the whole intent) is reachable only when a caller deliberately omits both `requireAmount` and the amount, and no caller does.

Evidence. Offline ("Codex C3"): the normaliser table; reservation amounts null, 0, -1, 12.5, Infinity, NaN, 2^53, '30.00', 'abc' each -> reserve_malformed with zero provider calls; '2500' -> one provider call with `amount=2500`; `refundPaymentIntent` with `requireAmount` refuses 'x' and sends `amount=777` for 777. Shared-payment isolation end to end remains with the preview proof (C4).

## C4: evidence and concurrency

Implementation. 0096: `respond_booking_move` and `lapse_booking_moves` capture `clock_timestamp()` AFTER acquiring the booking-then-move locks and use that instant for the deadline comparison and every stamp (PostgreSQL `now()` is the transaction start). The finalizer honours `p_event_payload->>'_inject_failure'` AFTER the stamp and the event insert, only when `get_deployment_identity()` is not production, to prove the rollback in a test.

Evidence (database, "Codex C4", real lock barrier through a direct Postgres connection to demohub-rebuild-check): the deadline is set three seconds ahead, a transaction holds the booking row lock, the brand's confirmation is started (it blocks), the lock is released after 4.5 seconds: the confirmation is refused `move_lapsed` and the move is lapsed, judged on the post-lock clock. Exact deadline: `reconfirm_due_at = clock_timestamp()` then confirm -> refused; twenty seconds ahead -> accepted. Rollback: the injected failure after the stamp and the event insert leaves the move unstamped, no event, lease kept. DST boundary: a move onto 2026-11-01 (America/Los_Angeles leaves daylight time that morning) resolves the 11:00 slot to 19:00Z (standard time) and the stored deadline equals `move_reconfirm_deadline(moved_at, start_at, 72)`; the retailer dialog computes the same policy on the same resolved instant (the preview and the saved deadline agreed in the browser check at 5:53 AM for a 72-hour window). The remaining race cases (lapse vs new move, confirm vs lapse, two workers) are kept and pass.

Still owed, and the enablement gate: the deployed isolated preview with Stripe test mode and controlled recipients (paid move-confirm with no refund; paid decline; paid lapse; failure and recovery; duplicate and concurrent settlement; two bookings on one shared payment with only the moved allocation refunded; ordinary paid cancellation; old proposal acceptance), recorded with SHA, booking, allocation, request and provider ids. In that preview only, `RETAILER_MOVES_ENABLED=true` is set deliberately for the test; Production stays unset.

## Checks on the tested SHA
Current main (1ce15f5) merged into the branch (89d39c1, clean). On the merged tree: `npm run check` and `node tools/check-html-undef.mjs` green; `npm test` (offline chain, demo_move_offline 89/89) green; `tests/demo_move.test.mjs` on demohub-rebuild-check and the regression suites route_flows, cron_heartbeats, notification_worker, owner_booking_events, store_contact_notifications: counts in the last section. The branch adds no em dash. CI `EXPECTED_MIGRATIONS` is 94 on this branch.

## Rollback build
The specific tested compatible build is the release SHA below with `RETAILER_MOVES_ENABLED` unset: tests/demo_move.test.mjs "Codex RM-7" proves, on that build, that creation is refused while brand confirm/decline, the deadline lapse, the settlement (cancel + refund handoff) and the sweep all run. No build before 0efe8ee (the 0095 corrections) carries the settlement machinery, so once any move exists no earlier build is compatible; rolling back the switch, not the code, is the procedure. Move rows, refund requests and cases are never deleted.

## Cutover
1. Paste `0094-0096-retailer-demo-move-paste.sql` once on demohub-prod (guarded, one transaction, verify block at the end).
2. Deploy the release SHA with `RETAILER_MOVES_ENABLED` unset on Production.
3. Verify the refund worker and notification worker heartbeats stay green for a cycle.
4. Preview proof (C4), then David's authorization, then `RETAILER_MOVES_ENABLED=true` on Production and redeploy.

## Results on the tested SHA
Tested release SHA: `4aed377` (feat/retailer-demo-move, main 1ce15f5 merged at 89d39c1; this document is committed on top of it). Compatible rollback build: `4aed377` with `RETAILER_MOVES_ENABLED` unset.

| Suite | Result |
|---|---|
| tests/demo_move_offline.test.mjs (offline, in `npm test`) | 89 passed, 0 failed |
| tests/demo_move.test.mjs (demohub-rebuild-check, in `test:routes`, includes the C1 finalizer cases and the C4 lock-barrier, exact-deadline and DST cases) | 72 passed, 0 failed |
| route_flows | 191 passed, 0 failed |
| cron_heartbeats | 75 passed, 0 failed |
| notification_worker | 86 passed, 0 failed |
| owner_booking_events | 19 passed, 0 failed |
| store_contact_notifications | 117 passed, 0 failed |

`npm run check`, `node tools/check-html-undef.mjs` and `npm test` green on 4aed377; no em dash added by the branch.
