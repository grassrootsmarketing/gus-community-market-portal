# Retailer demo moves: closure for Codex R2-1 and R2-2 (revision 3)

Date: 2026-10-17. Branch `feat/retailer-demo-move`. Input: Demohub-Demo-Move-Rev2-Review-for-Claude-2026-10-17.md (candidate 4aed377). Tested release SHA: last section.

Scope of this response, as requested: R2-1 implementation and test evidence, R2-2 status, final SHA, migration hashes, remaining authorization. C1 to C3 are not re-explained. Creation stays OFF on Production (`RETAILER_MOVES_ENABLED` unset); nothing merged to main; no production write, email or refund.

## R2-1: reserved money is not completed refund money

Implementation.
- api/_booking-moves.js: `nothing_refundable` no longer maps to `already_refunded`. `classifyNothingRefundable` reads the booking's allocation and its refund requests and decides from persisted accounting: `refunded_amount >= customer_amount` is the only way to `already_refunded`; otherwise a live request of another operation (reserved, submitted, pending, requires_action, failed_retryable) is LINKED to the move (`refund_request_id`) and labelled by its own state (`submitted` with the provider, else `pending_worker`); a parked request (requires_review, failed_terminal, failed, canceled) or a balance covered by neither opens the `move_refund` review case (persisted, per C1) and labels `review_required`. No second reservation and no provider submission are introduced.
- 0099 `finalize_move_settlement` (same signature as 0096; 0097 and 0098 belong to the brand booker branch, hence the number): `already_refunded` is accepted only when the allocation's `refunded_amount` covers `customer_amount` or the booking is recorded `refunded` by the verified ledger path; the 0096 clauses "reserved balance exhausted" and "any succeeded request" are removed (the migration's postcondition asserts their absence). A label must agree with the named request's persisted state: `succeeded` requires `succeeded`; `submitted` requires submitted / pending / requires_action (or succeeded); `pending_worker` requires reserved / failed_retryable / submitted / pending / requires_action (or succeeded); a request in requires_review / failed_terminal / failed / canceled can only be represented as `review_required` with the case. Mismatches refuse `request_state_mismatch` and write nothing.
- Messages: the brand's cancellation email and the response route already keep cancellation and refund state apart; "already been refunded" is now reachable only through completed accounting; a linked live obligation reads "being processed".

Evidence.
- Offline (tests/demo_move_offline.test.mjs, "Codex R2-1"): fully reserved by another operation and unsubmitted -> linked, `pending_worker`, zero provider calls, event says `pending_worker`; refund pending with the provider -> `submitted`; parked reservation -> review case naming the request; partial completed plus the remainder reserved -> linked to the live remainder, `pending_worker`; fully completed -> `already_refunded`; no unreserved balance and no request -> review case (balance unaccounted); the linked path needs no case so a dead case service does not block it; no allocation -> review case; the email wording table.
- Database (tests/demo_move.test.mjs, "Codex R2-1", demohub-rebuild-check, real ledger rows): a paid group with TWO allocations on one payment intent; the brand declines the moved booking; an ordinary retailer cancellation (refundable, force) and the move settlement run together: exactly ONE refund request for the booking, at most one (spied) provider refund call, `refunded + reserved = 3000` (no over-refund), the move settled with the request LINKED and labelled by its state (never `already_refunded`), the brand event stating that state, and the sibling allocation untouched (0 refunded, 0 reserved, booking still confirmed). Direct finalizer calls on a claimed move whose allocation is fully RESERVED with nothing completed: `already_refunded` -> `already_refunded_inconsistent`; `succeeded` and `submitted` labels on the reserved request -> `request_state_mismatch`; nothing written by the refusals; `pending_worker` with the reserved request -> accepted and linked.

## R2-2: the release gate

Not closed by this response. The deployed isolated preview with Stripe test mode and controlled recipients (paid confirm without refund; paid decline; lapse; failure and recovery; duplicate and concurrent settlement; two bookings on one shared payment with only the moved allocation refunded; ordinary cancellation; old proposal acceptance) has not been run; it needs a deployed preview of this SHA with `RETAILER_MOVES_ENABLED=true` set on that preview only, test-mode Stripe keys and a sink recipient, and David's go. The database suite's shared-payment case above is a real-ledger rehearsal of the isolation rule with a spied provider, not the preview proof. The feature must not be reported ready to enable until that run is recorded.

Combined-release note: this branch is integrated with current main (which now carries the brand booker files 0097/0098) at the merge below, and every suite below ran on that combined tree. The booker branch's role-aware responses are not part of this branch; if the booker work changes who may answer a move, that recheck belongs to its own release.

## Migrations and paste
0094 616817418c9e374548104bfcf6c29e0e173d122349410b0fd201c03517b4c91b, 0095 0fdca9472b4e2fadbacb17e22da8424a6532efae4a4a9a698edfecae974139fe, 0096 a5a54c6716ef8738fe513672475aa3507dbe6200ec12a1844b3b0ba0884dbd7a (all unchanged from the versions applied to demohub-rebuild-check), 0099 b58b098f5e11da5680ee3672d9606ed733f7d16d307faabcb4efe96dd156647c (forward, applied there after 0096 with its ledger row). ONE guarded transaction for all four: `Documents/Codex/cutover-kit/0094-0099-retailer-demo-move-paste.sql` with `MANIFEST-0094-0099.json`; the 0094-0096 kit was withdrawn. The guard refuses if any of the four is already in the ledger, if `booking_moves` or `bookings.pending_move_settlement` exists, if `accept_reschedule` is not the 0076 body or already carries the 0095 rule, or if the events kind CHECK is not the 0091 shape. The booker paste (0097-0098) is independent of it.

## Rollback build
The tested compatible build is the release SHA below with `RETAILER_MOVES_ENABLED` unset (tests/demo_move.test.mjs "Codex RM-7" on that SHA: creation refused, brand answers, lapse, settlement and sweep all run). No build before the 0095 corrections carries the settlement machinery, so once any move exists the procedure is the switch, not an older build.

## Results on the tested SHA
Tested release SHA: `5bef451` (feat/retailer-demo-move; main c326560 merged at 58176e7, clean; this document is committed on top). Compatible rollback build: `5bef451` with `RETAILER_MOVES_ENABLED` unset.

| Suite | Result on 5bef451 |
|---|---|
| tests/demo_move_offline.test.mjs (offline, in `npm test`; includes the R2-1 cases) | 98 passed, 0 failed |
| tests/demo_move.test.mjs (demohub-rebuild-check; includes the real-ledger R2-1 cases) | 85 passed, 0 failed |
| route_flows | 191 passed, 0 failed (a first run showed three outbox rows left `claimed` by a concurrent process on the shared project; the suite was re-run alone and passed in full) |
| cron_heartbeats | 75 passed, 0 failed |
| owner_booking_events | 19 passed, 0 failed |
| store_contact_notifications | 117 passed, 0 failed |
| notification_worker | NOT RUNNABLE on the shared test project at this SHA, for two reasons outside this branch: the brand booker branch's migration 0097 (applied to demohub-rebuild-check, not on main) changed `brand_members_role_check` to owner/booker, so main's fixture insert (`role: 'member'`) is refused at setup; and another session was running suites against the same project during these runs (claim collisions). Last clean run of this suite on this branch: 86/86 at 4aed377, twice. The files changed since (api/_booking-moves.js, api/_booking-refund.js, the refund worker's verdict, 0099) are not exercised by that suite. It must be re-run on the combined tree once the booker branch's updated suite lands on main, or on a quiet project with a fixture that uses an allowed role. |

`npm run check`, `node tools/check-html-undef.mjs` and `npm test` green on 5bef451; no em dash added by the branch; CI `EXPECTED_MIGRATIONS` 95 on this branch.
