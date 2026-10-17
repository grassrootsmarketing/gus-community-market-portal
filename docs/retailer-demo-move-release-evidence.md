# Retailer demo moves: release evidence note (after the revision 3 decision)

Date: 2026-10-17. Branch `feat/retailer-demo-move`. Input: Demohub-Demo-Move-Rev3-Decision-2026-10-17.md (candidate 5bef451, R2-1 closed).

## Final SHA
`8a05c3d`. Suites below ran at `00aeb25` (the corrected notification-worker fixture); `8a05c3d` adds one comment line to `.github/workflows/verify.yml` and no code. Creation stays OFF (`RETAILER_MOVES_ENABLED` unset on Production). Nothing merged to main, nothing deployed, no production write.

## Notification-worker regression: restored and passing
The suite's second brand contact was inserted with `role: 'member'`, which the booker migration 0097 (applied to demohub-rebuild-check) refuses (`brand_members_role_check`: owner | booker). The fixture now inserts a co-OWNER (`role: 'owner'`): valid under the baseline schema (role is free text, default 'admin') and under 0097, and a COI-decision recipient under every recipient contract, so the coverage (two recipients, both emailed on approve and reject, superseded decision not emailed) is unchanged. Result on the corrected fixture, run alone on demohub-rebuild-check: **86 passed, 0 failed**. The other suites were not re-run after this fixture-only change; their last results on this branch (route_flows 191, cron_heartbeats 75, owner_booking_events 19, store_contact_notifications 117, demo_move 85, demo_move_offline 98) ran at 5bef451, whose code is identical to 8a05c3d except the fixture and the CI comment.

## Corrected code and schema inventory
- Git: `feat/retailer-demo-move` at 8a05c3d = main `c326560` (merged at 58176e7) plus this branch's commits. The booker branch (`feat/brand-booker`) is NOT merged into it; the COI expiry pings branch (`feat/coi-expiry-pings`) is NOT merged into it. The earlier packet's sentence "main now carries the booker files" was wrong and is withdrawn.
- Migration files in this tree: main's 91 (through 0092) plus 0094, 0095, 0096, 0099 (95 files; CI `EXPECTED_MIGRATIONS` 95). Not in this tree: 0093 (coi-expiry-pings branch), 0097 and 0098 (booker branch).
- Migrations applied to demohub-rebuild-check (ledger): everything through 0099, including 0093 (coi-expiry), 0097 and 0098 (booker). That is why the shared test project is ahead of any single branch.
- Intended production chain for THIS feature: 0094, 0095, 0096, 0099 in one guarded transaction (`cutover-kit/0094-0099-retailer-demo-move-paste.sql`, `MANIFEST-0094-0099.json`); the guard refuses if any of the four is in the ledger, if `booking_moves` or `bookings.pending_move_settlement` exists, if `accept_reschedule` is not the 0076 body or already carries the 0095 rule, or if the events kind CHECK is not the 0091 shape. It neither needs nor touches 0093, 0097 or 0098; their own kits are separate.
- Booker authorization is not part of this release. If it is deployed later, move responses and recipient rules must be rechecked on that integrated release; the move branch's team-member notification tests do not certify the booker privacy contract.

## Paid preview: NOT run; what is missing
No deployed preview of this branch exists. Producing one requires, from David:
1. Authorization to push `feat/retailer-demo-move` to GitHub (the Vercel git integration then builds a Preview deployment of that branch; pushing a feature branch does not touch main or production).
2. `RETAILER_MOVES_ENABLED=true` on the Vercel **Preview** scope only (not Production), then a redeploy of the preview.
3. Confirmation that the Preview scope points at demohub-rebuild-check with Stripe TEST keys and a sink mail recipient (the project's standing Preview configuration), and the deployment-protection bypass for the browser session.
4. Authorization to make test-mode card payments on that preview (Stripe test card), with the resulting booking, allocation, refund-request and provider ids recorded against the deployed SHA.
Until those are in place the gate stays open and the feature is not ready to enable. A Stripe spy is not the paid preview; none of the database results above claims otherwise.

## Rollback SHA
`8a05c3d` with `RETAILER_MOVES_ENABLED` unset: creation refused, brand answers / lapse / settlement / sweep / notices all run (tests/demo_move.test.mjs "Codex RM-7"). No earlier build carries the settlement machinery; the switch, not an older build, is the rollback once any move exists. Move rows, refund requests and cases are never deleted.

## Remaining authorization
David: the four preview items above; then production: paste 0094-0099 once, deploy 8a05c3d (or the SHA the preview run ends on) with the switch unset, check the refund worker and notification worker heartbeats, and enable only after the preview evidence is recorded and accepted.
