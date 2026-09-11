# Demohub — Release B Closure Packet (corrected after Codex's third review, C1 … C4)

**Responds to:** Codex "Release B — third closure review and focused handoff" (2026-09-11): substantial closure accepted, four focused items (C1–C4), no unconditional deployment approval, packet corrections requested.
**Supersedes:** every earlier Release B packet (2026-09-10 evidence packet; 2026-09-11 packets for `accaefa1`, `778ef1e`, `ba4909e`). This is the single packet for Release B.
**Prepared:** 2026-09-11 · **Branch:** `feature/release-b-slots-blackouts` (stacked on Release A `4ff5ea4`)
**Readiness:** built and verified on demohub-rebuild-check; **not deployed**; the final-candidate CI gates and every operator step are listed in §9–§10.

---

## 1. Identity (corrected)

| Item | Value |
|---|---|
| **Final candidate SHA** | `7d6cccdd5a31841386128e1fc435f2274737bd61` — the branch head; every proof in §5–§6 was taken on this tree (see §5 for the exact sequence) |
| Commits in this round (on top of `ba4909e`) | `06fc88b` C1 + C3 (migration 0078, worker) · `5c6083b` C2 (route outcomes) · `ae2b555` C4 (snapshot helper) · `d6b4f9a` 0079 + packet correction (apply-all default) · `7d6cccd` regenerated Stripe evidence |
| Candidate history | `5100e68` rejected by Codex's first Release B review · `c49eac7` = the tree Codex's second review examined (B-01…B-08 corrections; that review did **not** unconditionally close them) · `accaefa1` = an intervening fixture-fix candidate (its staging pass 1 failed on a second notification fixture) · `778ef1e` = the round-2 closure candidate: run 34579737286 fully green (**five** jobs: suites ubuntu + windows, clean build A/B, staging pass 1, staging pass 2) · `ba4909e` = post-freeze merge of production hotfix `9fa0854` (suites-only run 34588368732; **not** full staging verification) · `7d6cccd` = this packet's candidate |
| Migrations | 0000–0079 (**80** SQL files + README). New this round: `0078_release_b_fulfillment_generations_and_outcomes.sql`, `0079_apply_all_copy_slots_default_false.sql` (both forward-only; 0075–0077 untouched). CI `EXPECTED_MIGRATIONS: '80'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0074–**0079** applied; ledger rows `0073`–`0079` recorded |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): code `9fa0854` (signup-category hotfix, deployed 2026-09-11 10:13Z), ledger `0060`–`0072`; **holds ON** since 2026-09-11 (David's operator decision, §8); inventory §8 |
| CI (this candidate) | run **34659147025** on `7d6cccd`, dispatched with `clean_build=true`, `staging_gate=true` — suites in progress at packet time; clean build + both consecutive staging passes need David's `staging` approval. (Run 34659121127 on `d6b4f9a` was cancelled by me: superseded by the evidence commit.) |
| Kill switch | `SLOT_EDITING_ENABLED` (literal `true`; default OFF) gates slot saves/resets, blackouts, apply-all slot copying (`p_copy_slots`, explicit from the API and **default false in the RPC since 0079**), slot lists on venue creation, and the editors |
| Containment | Gus only, signup OFF, capacity 1, no viewers, support OFF; **holds ON** (reported operator change, §8) |

## 2. C1 … C4 disposition

| Item | Status | What changed | Proof (`tests/fulfillment_lifecycle.test.mjs`, real DB + shipped handlers with provider spies, ledger safety gate; **46/46**) |
|---|---|---|---|
| **C1 (P1)** an old held-stage worker could complete newer paid work | **Closed** | 0078: `booking_fulfillments.generation`. `apply_verified_payment` re-issues a captured hold's row as generation+1 **and drops the old lease in the same statement** (the paid work is claimable at once, attempts reset). `claim_fulfillments` returns the generation. `complete_fulfillment(…, p_generation)` accepts only the current generation's lease owner; the 6-argument version is **dropped** (cutover fence — a deployment that predates 0078 cannot record progress). The worker passes its generation, judges held-stage work on the **current facts** (still `held`, still `authorized`, still this generation — a capture flips `payment_status` before the booking is promoted, so status alone is not enough) before any hold notice, and reports a refused completion as `stale_lease_or_generation`, never as done. `projection_anomalies()` gains `paid_booking_not_promoted` (15-minute in-flight grace) and `fulfillment_done_but_booking_not_promoted` (immediate). | Claimed held worker (gen 1) parked; capture lands → row is gen 2 / pending / lease NULL / attempts 0; the old worker's completion (gen 1) returns **false** and changes nothing; the resumed old worker (actual `runFulfillment`) sends **no** hold notice and records nothing; no demo faked; audit reports `paid_booking_not_promoted` once past the grace and `fulfillment_done_but_booking_not_promoted` for a lying terminal row; a fresh drain claims gen 2 and finishes: pending target → booking pending/paid, one payment notice; confirmed target → booking confirmed with **exactly one** demo; capture replay idempotent (gen stays 2); expiry before completion → old worker records `superseded`, no notice, booking stays expired; `payment_ledger_adversarial` T18: owner with a stale generation refused. |
| **C2 (P1/P2)** transition outcome after provider-side success | **Closed** | **A.** 0078 `booking_transition`: an action whose own terminal target is already the current state converges (`ok=true, reason='already_applied'`: audited fields applied, projection ensured/retired idempotently); every other mismatch stays `state_changed`. The route treats it as a truthful success, still sends the notice when **this** request did the provider-side work (release or capture), marks a concurrent duplicate `idempotent` without re-mailing. Confirming a hold re-reads the booking after capture: with auto-confirm on, the capture-side drain has confirmed it and created its demo, so the capacity re-check skips and the transition converges to the **same** demo id. **B.** A logical refusal (`ok:false`) after the refund step opens ONE deduplicated `settlement_exception` (`transition:<booking>`) and answers 409 **with** `refund_status`, `refund_id`, `reconciliation_case_id`, `reconciliation_recorded` and a message that says the refund was submitted. The thrown-RPC 500 path and the plain stale-tab 409 are unchanged. | **A:** cancel of an authorized hold → **200**, `refund_status: auth_released`, booking cancelled with `cancelled_at` + `cancel_reason`, `refund_id` null, exactly one PI cancel, zero refunds, one cancellation email; replay → 409 "already cancelled" with no further provider call; no case opened. Decline → 200 likewise. Manual confirm of a hold, auto-confirm **OFF**: one capture, booking confirmed/paid, one demo, outbox row done as gen 2, payment notice + confirmation. Auto-confirm **ON**: capture-side drain confirms first, route converges → 200 with the same demo id, **one** demo, no capacity conflict, confirmation still sent. **B:** paid pending booking; decline parked at its transition **after** its refund (one `/refunds` call); confirm lands; decline → **409** `state_changed` with `refund_status: submitted`, `reconciliation_recorded: true`, one `settlement_exception` (`transition:<id>`, reason `…refused_after_refund_step`); booking and demo stay confirmed; replayed decline refused up front, no second case. |
| **C3 (P2)** manual confirmation stranded payment-notice retries | **Closed** | 0078: `promote_paid` with target `pending` against a `confirmed` booking returns `already_advanced` (never a downgrade). The worker records the job done with `already_advanced:confirmed:payment_notice_superseded_by_confirmation` — the confirmation the retailer's action sent supersedes the pending-stage notice — instead of throwing `promote_refused` until the retry cap. | Pending-target job with an injected mail failure → not done, retryable, lease released, booking pending; retailer confirms (200, demo); the retry is claimable at the same generation → `already_advanced`, done, recorded, booking still confirmed, one demo, **no** extra mail, no retry-cap case; after a cancel a replayed job is `superseded`, the retired demo stays retired. |
| **C4 (P2)** partial/missing snapshots treated as legacy | **Closed** | `fetchBookingSnapshots()` requires every requested linked booking to be returned (`snapshot_lookup_incomplete`), refuses one-timestamp rows and intervals that do not run forwards (`snapshot_lookup_malformed`), and records a row with **both** timestamps NULL as an explicit legacy state (`null`) established by a successful read — the only linked case the feeds may reconstruct (`offering_anomalies()` reports those rows as `class=legacy`). Unlinked legacy demos keep their fallback. | Missing requested id → incomplete; partial → malformed; end ≤ start → malformed; empty later chunk → incomplete; explicit both-NULL → legacy `null`; healthy duplicates → one 2-hour snapshot with its zone. Feed-level R3 tests (both feeds 503 `no-store` on failed/malformed lookups; same instant after a retailer timezone change; unlinked legacy served) unchanged and green. |

**Codex's offline probes** (`release-b-round3-offline-probes-2026-09-11.mjs`), re-run per section against this tree: **B, C2 and D no longer reproduce** (held worker no longer marks captured work done; a case is now opened after the refund; the helper throws `snapshot_lookup_incomplete`). **A and C cannot reflect the fix by construction**: their in-memory `booking_transition` stubs hard-code `state_changed` and assert the 0077 allow-list text; against 0078's text probe A's own assertion trips. The real-database suite above carries the expected-correct assertions for those two cases, as the review asked.

## 3. Corrections to earlier packet statements (as requested)

- **Apply-all guarantee.** The RPC enforces the **caller-supplied** `p_copy_slots`; it does not read the Vercel flag. The shipped API passes the mode explicitly. 0079 changes the RPC default to **false**, so a future privileged caller that omits the mode gets the hours + capacity copy and must ask for slot copying. Stated accurately in §1.
- **Review history.** Codex's second review examined `c49eac7`; `accaefa1` was an intervening fixture-fix candidate; that review did not unconditionally close B-01…B-08. Stated in §1.
- **Job count.** The green run on `778ef1e` had five jobs (the suites matrix is two of them). Stated in §1.
- **Post-freeze merge.** `ba4909e` (hotfix `9fa0854`, three files / 70 added lines including the server-side category follow-up) had suites-only verification. This packet freezes **one** final SHA after C1–C4 and asks for the full gates on it (§9).

## 4. Design decisions in this round (for ratification)

- **Fencing token = integer generation on the outbox row**, bumped only by the capture re-issue. Old lease invalidated in the same UPDATE; completion requires (owner, generation). Attempts reset for the new work.
- **The 6-argument `complete_fulfillment` is dropped**, not kept as a wrapper: an old deployment's completion call fails with a missing-function error and cannot write anything (cutover proof, §10). A row it was working on is re-leased by the new code after the lease expires (≤ 180 s).
- **Held-stage notice is judged on facts**, not on the claimed object: booking still `held` **and** `authorized` **and** the row still this generation. Anything else is `superseded:hold_no_longer_active:<status>:<payment_status>`.
- **`already_applied` is narrow**: only the action's own terminal target counts as "already done" (cancel→cancelled, decline→declined, confirm→confirmed). Confirm-vs-cancel and cancel-vs-confirm still conflict.
- **C2-B records, it does not converge.** Booking/demo are left as the winning request set them; the refund is tracked by the ledger; one case per booking (`transition:<id>`, deduplicated) tells an operator. No second money operation, no policy change.
- **C3 supersedes the pending-stage notice** with the confirmation the retailer's action already sent; the job is recorded done with that reason, not retried.
- **C4 explicit legacy** = both timestamps NULL from a successful read; a missing row is never legacy.
- **Audit grace** for `paid_booking_not_promoted` is 15 minutes (outbox lease 180 s, cron every 15 min).

## 5. Test results — exact sequence on this tree (demohub-rebuild-check, 2026-09-11)

Commands (from `C:\Users\David\demohub`, env from `demohub.env` with `SB_DB_URL` rewritten to the session pooler; ledger suites additionally `LEDGER_TARGET_REF=tileejdviuvijumjeplv ALLOW_STAGING_LEDGER_TESTS=yes`):

1. Migrations applied in order to demohub-rebuild-check with ledger rows: `0078` (16:0x), `0079` (16:4x).
2. `node tests/fulfillment_lifecycle.test.mjs` → **46/46** (after 0078).
3. Full battery after 0078, before 0079: `npm run check` ✓ (80 migrations, 53 modules import, no-undef over 109 files, binding) · `npm test` (19 suites) ✓ · `npm run check:columns` ✓ · `npm run test:ledger` (fixtures 12, payment adversarial **63**, holds adversarial 28, lifecycle 46) ✓ · `npm run test:routes` (route_flows 191, cron_heartbeats 75+30, store_contact_notifications 117, notification_worker 72, isolation_matrix 45, compliance_tenant 35, support_access 125, support_access_race 28, venues_bulk_import 78) ✓ · `npm run test:capacity` (capacity_guard 35, capacity_serialization 38, slots_blackouts 97, slots_blackouts_race 19, release_b_corrections 117) ✓ · `npm run test:live` (11, 21) ✓ · `node tests/reschedule_atomic.test.mjs` 50 ✓.
4. `node tests/admin_controls_dom.e2e.mjs` (real Chromium over the in-process server) → **52/52**.
5. `node tests/stripe_testmode_grouped.e2e.mjs` (real Stripe test mode, Playwright pays the hosted Checkout, signed real events replayed) → **88/88**; evidence regenerated: `tests/evidence/stripe-testmode-grouped-2026-09-11.md` (run `e2e-mtxl94zj-qow6w`) + two PNGs — retailer and brand feeds both show venue B's 2-hour snapshot event (`20261012T200000Z–220000Z`).
6. After 0079: `release_b_corrections` **117/117**, `slots_blackouts` **97/97** (the apply-all suites).
7. `npm run check` on the final tree ✓.

Labels: route suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe for the **paid** path; the DOM suite is a real browser against the in-process server. None is a deployed-Vercel proof (§10). The hold path is covered in-process with spied Stripe (lifecycle suite C1/C2-A); a **real test-mode hold journey** (authorization on the hosted Checkout, capture, release, expiry, worker overlap, replay through the deployed candidate) is not yet part of the Stripe journey — it is listed as an outstanding evidence step in §10, to run against the deployed preview.

## 6. Occurrence audits (demohub-rebuild-check, after every suite above)

| Audit | Result |
|---|---|
| `offering_anomalies()` legacy / invariant | 0 / 0 |
| `snapshot_drift()` | 0 |
| `schedule_mismatches()` | 0 |
| `projection_anomalies()` — incl. the new `paid_booking_not_promoted` and `fulfillment_done_but_booking_not_promoted` branches | 0 |
| `capacity_invariant_violations(NULL, true)` | 0 |
| fixture retailers left behind (`rt-%`, `rbfix%`, `e2e-%`) | 0 |

## 7. Upgrade and rollback plan

**Production upgrade (SQL editor, in this order, each followed by its ledger row):** `0074` → `0075` → `0076` → `0077` → `0078` → `0079`. `0073` is omitted on purpose and must **not** be marked applied. Never edit an applied migration in place.

**Cutover coordination (C1):** apply the migrations, then deploy the candidate promptly. Between the two, the old deployment's worker cannot record progress on any outbox row (its 6-argument completion call no longer exists) — nothing can be mis-recorded; a row it was holding is re-leased by the new code once its lease expires (≤ 180 s) and finished on the current generation. Signed webhook handling is unchanged. New hold intake is an operator flag (§8).

**Configuration (Vercel Production; redeploy after env changes):** `NOTIFICATION_WORKER_ENABLED=true`; `SLOT_EDITING_ENABLED=true` only when Gus should edit slots/blackouts (enforcement is on regardless); `PROVISIONAL_HOLDS_ENABLED` per §8.

**Rollback / disable:** this code with `SLOT_EDITING_ENABLED` unset (no new slot lists/blackouts; enforcement, bookings, transitions, feeds, refunds, outbox continue). Reverting to Release A code with 0075–0079 present is **not** compatible (custom slots; dropped 6-argument completion). No path deletes reservations, snapshots, blackouts or owed refunds.

## 8. Production inventory and the holds envelope

- Read-only inventory (REST, 2026-09-11 ~16:35Z): retailers `gus`, `harvest-lane-demo`, `__owner__` (all Los Angeles); Gus's 5 venues valid with hours and the standard offering, 0 blackouts; demo-tenant venues have no hours (offer nothing); **future bookings 1 (0 active), 0 authorized holds, future demos 11 (legacy/demo-tenant)**. To be re-read immediately before the migrations; any hold or active reservation that exists by then is handled by 0075's backfill and preserved by the tested paths, and will be listed in the deploy note.
- **Holds:** `PROVISIONAL_HOLDS_ENABLED=true` was set in Vercel Production by David on 2026-09-11 on build `1806de4` (now `9fa0854`) because the hard COI gate was a real friction point; verified from the public status probe. This is a **reported operator decision**, not something Codex verified. Codex recommends pausing **new** hold intake until C1/C2 are deployed; existing authorizations keep their controlled capture/release/reconciliation either way. Decision pending with David at packet time; no bookings or holds have been placed on production since the flip (inventory above).

## 9. GitHub gate

- `778ef1e`: run 34579737286 — five jobs green (historical evidence, kept).
- `ba4909e`: run 34588368732 — suites only (not full staging verification).
- **`7d6cccd`: run 34659147025** — dispatched with `clean_build=true`, `staging_gate=true`; suites in progress; the clean build and both consecutive staging passes require David's approval on the `staging` environment. Result to be appended; the candidate SHA does not change unless Codex asks for further changes.

## 10. Outstanding before acceptance / deployment (operator-owned unless noted)

1. David approves the gates on run 34659147025; record the clean build and both staging passes on `7d6cccd`.
2. Holds: David decides whether to pause new intake until deployment (flag flip + redeploy) or keep it on with prompt COI approvals.
3. Credential rotation (Codex §3 preflight); no credentials in any handoff.
4. Authorized deployed preview of `7d6cccd` on the existing Vercel project with test bindings, test Stripe and the mail sink — then (Claude) the real test-mode **hold** journey through the deployed handlers: authorization on the hosted Checkout, manual/automatic capture, release, expiry, worker overlap, replay.
5. Immediately before the migrations: refresh the production inventory (active bookings, authorized holds + expiry, payment/fulfilment state, saved occurrence timestamps, linked/unlinked demos) and compare preserved fields after 0075.
6. Production: 0074–0079 + ledger rows → merge to `main` → Production env flags → redeploy → verify the worker heartbeat and the five audits (incl. the two new projection branches) on production; containment otherwise unchanged.
7. Release C stays separate; Option 2 is not activated by anything in B.
