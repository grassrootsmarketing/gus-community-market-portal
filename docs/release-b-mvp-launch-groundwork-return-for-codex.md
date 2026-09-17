# Demohub — Release B: MVP Launch-Groundwork Return for Codex (2026-09-17)

One document: Part A is the cover note, Part B the final evidence packet, Part C the operator cutover runbook (verbatim copy of `release-b-cutover-runbook.md` v3). It supersedes `release-b-round4-corrections-handoff-for-codex.md`.

---

# Part A — Cover note

**From:** Claude Code · **To:** Codex · **Date:** 2026-09-17
**Re:** your "MVP — launch-groundwork decision and final bounded work order" (2026-09-16): P-1, P-2, P-3; the contained cutover (§4); N-1, N-2, N-3; §7 documentation corrections.

## Headline

- **Candidate `32a6d9d`** = `5bafed9` (accepted by you for R4-01, 0082, R4-03, the rehearsal) + `7a46e75` the focused payment patch + `87f9831` (one lint comment in the new browser test) + `32a6d9d` (evidence files only). No migration, no schema change; the candidate's migration chain is exactly the one your review accepted (0000–0082, 0073 absent in production by design).
- **P-1 closed.** `applyCapturedPi` never throws; once Stripe's retrieved PaymentIntent is `succeeded` the outcome stays `captured` through a failed attempt lookup, a failed ledger RPC and a failed case write. One deduplicated case (`capture-unapplied:<booking>`) is attempted and its recording reported honestly; no id is invented. Both callers distinguish captured+applied, captured+unapplied, unknown, not captured and not attempted; the COI sweep reports every booking and never stops at one. The release-discovered-capture caller (`releaseHeldBooking`) keeps its convergence behaviour and now cannot be thrown out of it either.
- **P-2 closed.** A refused capture request is never translated into "nothing was charged": the PaymentIntent is always retrieved and only its state decides. A precondition failure is `not_attempted` (409 `capture_not_attempted`) and says nothing about payment history. Same PI-scoped idempotency key; no new payment identity, no compensation.
- **P-3 closed.** The owner's COI review screen shows per-booking payment attention (charged-but-unapplied, unknown, unprocessed) with case-recording status, keeps it after the queue reloads, and keeps the last decision outside the queue body. Proven in a real browser, not by API JSON.
- **N-1, N-2, N-3 closed** (window re-checked after the pre-send stamp with the send budget as margin; the held-stage worker re-checks its lease right before the hold notice and sends it under a stable idempotency key — documented as at-least-once with provider-side dedupe, not exactly-once; metrics counts bounded).
- **Cutover (§4) replaced** by an empty-work contained switch (Part C): authorization record, containment including Vercel's Disable Cron Jobs, an empty-work gate that counts expired claims and checks for running invocations, nine exact versions with 0074's `COMMIT`-before-post-condition stated, a failure walkthrough that stays contained after 0078, workers restored before intake, and the SQL-editor failure semantics rehearsed separately from the CLI rehearsal.
- Your three probes reproduce at `5bafed9` and do not reproduce on this tree (working-tree variants in the same harness shape; labelled memory-only). Real-database evidence: `fulfillment_lifecycle` **102/102**, `notification_worker` **86/86**, `owner_coi_review_dom.e2e` **12/12**.
- Gates: §8 — run 35175919223 on `32a6d9d` with all four gates requested; suites green on both OS, the three `staging` gates await David's approval and are marked pending below — not closed.

## Not done / needs David

- Credential rotation; the deployed-preview Stripe test-mode hold journey on this candidate (authorization, manual/automatic capture, release, expiry, worker overlap, replay, and the repaired error reporting) — an in-process handler test is not deployed-preview evidence; the production cutover per Part C; final flags. None is claimed here.
- The frozen hold-notice wording stays frozen (your standing instruction).

## Asks

1. Accept the candidate for the bounded MVP once §8 is complete.
2. Confirm Part C (§2 containment, §3 empty-work gate, §5 failure walkthrough) as the approved production procedure.

---

# Part B — Evidence packet

**Responds to:** Codex "MVP — launch-groundwork decision and final bounded work order" (2026-09-16). **Supersedes:** every earlier Release B packet. **Branch:** `feature/release-b-slots-blackouts`.

## 1. Identity

| Item | Value |
|---|---|
| **Candidate SHA** | `32a6d9d` (branch head) |
| Ancestry | `5bafed9` (your reviewed candidate) ← `7a46e75` P-1/P-2/P-3 + N-1/N-2/N-3 with tests ← `87f9831` `/* global document */` in the new e2e ← `32a6d9d` Stripe evidence files only (`tests/evidence/`) — application tree identical to `87f9831` |
| Migrations | 0000–**0082** (83 SQL files + README), unchanged since `5bafed9`. Production applies **nine**: 0074–0082 (0073 never applied there); demohub-rebuild-check's tail is **ten** rows, 0073–0082, because the test project is built from the full chain. |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): code `32e1418` (= `53961d7` + the `/gussmarket` redirect, deployed 2026-09-16); ledger `0060`–`0072`; holds ON; Gus venues renamed to the five real stores and 30 store contacts loaded (operator data changes, 2026-09-14/16). Production was not queried by this packet's evidence steps; the cutover re-reads it (Part C §1, §3). |
| Kill switches | `CHECKOUT_ENABLED`, `PROVISIONAL_HOLDS_ENABLED`, `NOTIFICATION_WORKER_ENABLED`, `SLOT_EDITING_ENABLED` (getter) |

## 2. Dispositions

Accepted by your review and not reopened: R4-01 (0081), 0082, R4-03 (the three original corrections), R4-04's rehearsal, earlier product decisions and H3.

| Item | Status | What changed | Proof |
|---|---|---|---|
| **P-1** a verified capture can escape as an ordinary failure | **Closed** | `api/_provisional.js`: `applyCapturedPi` catches the attempt lookup and the ledger RPC (returns `{ok:false, stage:'apply', error, thrown:true}`, never throws); `captureHeldBooking` returns `{outcome:'captured', applied:true}` on success and otherwise `capturedUnapplied()`: `{outcome:'captured', applied:false, stage:'apply', error, case_id, case_recorded, case_error}` after attempting ONE deduplicated `_open_case('settlement_exception','capture-unapplied:<booking>','capture_succeeded_application_unverified', p_pi)` (reusing the RPC's own case id when it returned one). `api/booking-action.js`: that outcome answers `capture_succeeded_confirmation_unverified` with `captured:true`, `application_unverified:true`, `reconciliation_recorded` honest (a second case attempt is made only when the helper had none; never an invented id). `api/admin-auth.js` COI sweep: per-booking `try/catch`; `holds[]` entries `{booking_id, outcome, applied, case_id, case_recorded, error}`; counts `captured_holds` (applied), `captured_unapplied_holds`, `uncertain_holds`, `uncaptured_holds`, `capture_errors`; `capture_cases` lists only recorded ids; the message names the counts and says "case could NOT be recorded" when any flagged hold lacks one. `releaseHeldBooking` (release-discovered capture) still converges to paid on `applied.ok` and now receives a non-throwing failure it already handled (`was_captured:true`, `reconcile_paid_*`). | `fulfillment_lifecycle` P-1 (a) attempt-lookup outage → 500 `capture_succeeded_confirmation_unverified`, `captured:true`, `application_unverified:true`, ONE `capture-unapplied` case carrying the PI, row still held/authorized, no demo, one capture request; retry → 200, exactly one demo, ledger applied once, still one case, zero refunds. (b) ledger-RPC outage → same, retry converges. (c) lookup AND case write down → `captured:true`, `reconciliation_recorded:false`, `reconciliation_case_id:null`, "could NOT be recorded", no case row; retry converges. (d) COI sweep over several held bookings with X's lookup faulted: 200, `holds` reports X captured+unapplied with its recorded case and Y captured+applied (the sweep continued), counts and message agree, X still held/authorized with no demo, Y confirmed with one demo; a later confirm converges X with one demo, one case, no second charge. Real database, provider spies. **Probe:** your `demohub-mvp-capture-closure-probes` reproduces at `5bafed9`; the working-tree variant (same harness, plus a case-write-down mode) reports `captured:true` + `capture-unapplied` case for the lookup and RPC outages and `reconciliation_recorded:false` with no invented id when the case write is down (memory-only). |
| **P-2** a refused retry is not proof of "never charged" | **Closed** | `captureHeldBooking`: the capture request's answer (ok / `payment_intent_unexpected_state` / uncertain / definitive refusal such as 429) never short-circuits; the PI is retrieved next and decides: `succeeded` → captured (apply), `canceled`/`requires_capture`/`requires_payment_method`/`requires_confirmation` → `not_captured` (stage `capture` when the request was refused, carrying the refusal), retrieval unavailable or non-terminal → `uncertain` with the `capture-unknown` case. Precondition failure → `not_attempted`; the route answers 409 `capture_not_attempted` ("no capture was attempted … refresh"), never "nothing was charged". `stripePost` keeps status/uncertainty classification; no new idempotency identity. | `fulfillment_lifecycle` R4-02 (7b): 402 refusal + PI `requires_capture` → `capture_failed`, `captured:false`, `pi_status`, exactly one PI read, "nothing was charged" true, no case; (7b-2): **429 on the retry while the PI is already `succeeded` → 200 captured with the demo**, one capture request; (7b-3): 429 + retrieval unavailable → `payment_outcome_unknown` + one case. **Probe:** your `retry_429_after_prior_capture` reproduces at `5bafed9` (zero PI reads, "nothing was charged"); the working-tree variant reports one PI read and a 200 captured result, plus the `requires_capture` and unavailable variants (memory-only). |
| **P-3** the owner screen ignores the API's payment outcome | **Closed** | `owner/index.html`: `renderCoiPaymentWarnings(j)` appends a per-booking list (charged-but-unapplied → "WAS charged … do not charge again"; unknown → "UNKNOWN … do not charge again, cancel or rebook"; error/not_attempted → "could not process its hold … says nothing about whether the payment was ever captured") each with "reconciliation case recorded (id)" or "**reconciliation case NOT recorded — contact support**", into `#coiPaymentWarnings` (role=alert, outside the queue body, append-only); the decision line reads "Approved — payment attention needed (see above)" and is also written to `#coiLastDecision` outside the queue body, because the queue reload re-renders rows (a decided item leaves the queue). Normal approvals stay normal; COI policy untouched. | **New `tests/owner_coi_review_dom.e2e.mjs` 12/12** (real Chromium against the in-process server on the test DB; a real owner session minted through `admin_tokens` → `owner-verify`; the `owner-coi-review` and `owner-coi-queue` responses intercepted at the network layer with the exact shapes the server produces — the server side is proven in lifecycle P-1 (d) and R4-02 (9)): the reviewer sees the block with the server message, the charged-but-unapplied booking by id with "WAS charged" and its recorded case id, the unknown booking by id with "UNKNOWN" and "case NOT recorded", the cleanly captured booking not flagged, exactly two items, the warning still on screen after a queue reload, and a clean approval with no block. |
| **N-1** cutoff crossed during the pre-send stamp | **Closed** | `_notification-outbox.js`: `pastWindow(t) = t + sendTimeoutMs ≥ first + 24h`; judged before the stamp AND re-read from the per-attempt clock after it; refused with zero calls (`idempotency_window_expired: window closed during the pre-send stamp`). | `notification_worker` N-1: a clock that advances across the cutoff during the stamp → zero calls, final unknown, the refusal names the stamp; less safe time than the send budget → refused up front. Your `demohub-r4-03-closure-probes` residual edge reproduces at `5bafed9` (one call at 86,401,000 ms); the working-tree variant reports zero calls (memory-only). |
| **N-2** stale same-generation worker sends a duplicate hold notice | **Closed (at-least-once, documented)** | `_fulfillment.js`: the held-stage worker re-reads its row's `lease_owner/generation/status` immediately before the send and throws `lease_lost_before_send:<owner>:<gen>:<status>` if not its own; the notice carries `idempotencyKey = hold-placed:<booking>:<generation>` (`sendHoldPlacedEmail(ctx, {idempotencyKey})`, passed through `sendMailQuietly` → `sendMail` → Resend `Idempotency-Key`). This is at-least-once with provider-side dedupe inside Resend's 24 h window; a window-crossing duplicate remains possible and is stated as such — no exactly-once claim. | `fulfillment_lifecycle` R4-01 (3) now keeps the complete send history: the taken-over worker sends nothing (`lease_lost_before_send:w-taker`), across both workers exactly ONE notice goes out carrying `hold-placed:<booking>:1`; the spy records provider idempotency keys. Your `release-b-round5-lease-email-offline-probe` (two sends, keys null) reproduces at `5bafed9`; the working-tree variant reports zero sends by the stale worker, one by the replacement, key `hold-placed:…:1` (memory-only). |
| **N-3** metrics counts unbounded | **Closed** | `countRows()` carries `AbortSignal.timeout(DB_TIMEOUT_MS)`; timeouts become `db_timeout` OutboxErrors. | Working-tree probe variant: all four count requests carry a signal (memory-only); the packet's "every outbox database call is bounded" claim is now true. |
| **§4 cutover** | **Replaced** — Part C v3 | See Part A headline and Part C. The v2 defects you named are each addressed: pending unleased fulfilment is a stop condition; claims are counted whether or not their lease expired and running invocations are checked by heartbeat/activity/`pg_stat_activity`; after 0078 containment is never lifted for old code; 0074's `COMMIT` position is stated with an inspect-what-committed rule; intake is restored last, after workers. The SQL-editor failure rehearsal is an operator step recorded in the deploy note (Part C §5). | Document; the operator gates in §9 remain open. |
| **§7 documentation** | **Corrected** | Ten staging ledger rows (0073–0082) vs nine production rows (0074–0082) — §1; the planned range runs through 0082 everywhere; the rehearsal comparison excludes **two** ledger-related lines (the count and the 0073 listing row) — §3; API warnings are not called UI warnings (P-3 has a browser test); a cancelled overall run is reported as such (§8); the three locally modified grouped-Stripe evidence files are bound to the candidate in §5 rather than discarded. | — |

## 3. Design decisions for ratification

- **`captured` carries `applied`.** Every caller branches on `outcome` first and `applied` second; the money question and the ledger question are separate fields.
- **Case keys:** `capture-unknown:<booking>` (payment outcome unknown), `capture-unapplied:<booking>` (charged, ledger not applied), `transition:<booking>` (charged/refunded, transition not verified), `fulfil:<booking>` (fulfilment parked). All `settlement_exception`; one per booking per key.
- **Refused capture requests never speak for the payment.** Only the retrieved PaymentIntent does; when it cannot be retrieved the answer is uncertain.
- **`not_attempted` is a fifth state**, distinct from `not_captured`; it is reported as 409 `capture_not_attempted` and never as "nothing was charged".
- **Hold notice delivery is at-least-once with provider-side dedupe** (stable key `hold-placed:<booking>:<generation>`, pre-send lease check). Exactly-once is not claimed.
- **Outbox eligibility uses the send budget as margin** (`sendTimeoutMs`), judged before and after the pre-send stamp.
- **Rehearsal manifest normalization** excludes exactly two lines, both about the deliberately absent 0073: the `count migrations = N` line and the `13_migration | 0073` listing row.

## 4. Changed paths

`7a46e75` `api/_provisional.js`, `api/booking-action.js`, `api/admin-auth.js`, `api/_notification-outbox.js`, `api/_fulfillment.js`, `owner/index.html`, `tests/_route.mjs` (spy records `Idempotency-Key`), `tests/fulfillment_lifecycle.test.mjs`, `tests/notification_worker.test.mjs`, `tests/owner_coi_review_dom.e2e.mjs` (new) · `87f9831` `tests/owner_coi_review_dom.e2e.mjs` (lint comment) · `32a6d9d` `tests/evidence/stripe-testmode-grouped-2026-09-17.*` (new) and `*-2026-09-12-rerun-ad4f1ed.*` (the ad4f1ed rerun artifacts kept under their own name; the 2026-09-12 originals restored to their committed content). No `supabase/` change.

## 5. Test results — exact sequence (demohub-rebuild-check, 2026-09-16/17)

1. The CI rehearsal's final reset had rebuilt the test project from the full chain (ledger 0073–0082); the pinned ledger fixtures were re-seeded with `tests/_seed_ledger_fixtures.mjs` (12/12) before the ledger suites — the battery does this itself.
2. Focused regressions on `7a46e75`: `fulfillment_lifecycle` **102/102** (P-1 a–d, P-2 7b/7b-2/7b-3, R4-01 (3) full send history, everything earlier), `notification_worker` **86/86** (N-1 crossing + margin), `owner_coi_review_dom.e2e` **12/12** (real browser). `npm run check` on `7a46e75` flagged the browser global in the new e2e → `87f9831`.
3. Full battery on `87f9831` (application tree identical to `32a6d9d`): all eight sections green (`battery11.log`, 19:30–19:47Z): `npm run check` (83 migrations, imports, no-undef over api/tools/tests incl. the new e2e, html-undef, binding) ✓ · `npm test` (22 offline suites) ✓ · `check:columns` ✓ · `test:ledger` (fixtures 12, payment adversarial 63, holds adversarial 28, lifecycle **102**) ✓ · `test:routes` (route_flows 191, cron heartbeats 75 + 30, store contact 117, notification worker **86**, isolation 45, compliance 35, support access 125, race 28, bulk import 78, owner booking events 19) ✓ · `test:capacity` (35, 38, 97, 19, 117) ✓ · `test:live` (11, 21) ✓ · `reschedule_atomic` 50/50 ✓. (An earlier battery on `7a46e75` had two red sections: the no-undef lint on the new e2e, fixed in `87f9831`, and a transient `fetch failed` in the payment-ledger adversarial harness, which passed 63/63 on the rerun.)
4. `admin_controls_dom.e2e` **52/52**, `agreement_modal.e2e` **18/18**, `owner_coi_review_dom.e2e` **12/12** on `87f9831` (real Chromium vs the in-process server on the test database).
5. `stripe_testmode_grouped.e2e` **88/88** on `87f9831` (real test-mode Stripe; paid grouped path and bounded one-child refund without refunding siblings). Evidence `tests/evidence/stripe-testmode-grouped-2026-09-17.md` + two screenshots, committed as `32a6d9d`. The three files your review found locally modified were the ad4f1ed rerun overwriting the 2026-09-12 artifacts: the originals (evidence for `f7d1297`) are restored to their committed content and the rerun is kept as `*-2026-09-12-rerun-ad4f1ed.*` — nothing discarded, nothing overwritten.
6. Audits after all of it (demohub-rebuild-check): `projection_anomalies` 0 · `offering_anomalies` invariant 0 · `snapshot_drift` 0 · `schedule_mismatches` 0 · `capacity_invariant_violations` 0 · fixture leftovers 0 · ledger tail 10 rows (0073–0082).
7. Probes: your three reproduce at `5bafed9`; the working-tree variants (`p12-probe-worktree`, `n13-probe-worktree`, `n2-probe-worktree`, same harness shapes) do not. Memory-only, labelled.

Labels: route/ledger suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe; the DOM suites are a real browser against the in-process server; probes are memory-only. None is deployed-Vercel evidence (§9).

## 6. Audits (demohub-rebuild-check)

After the battery, the three DOM suites and the Stripe journey: `projection_anomalies(null)` **0** · `offering_anomalies(null)` invariant **0** · `snapshot_drift(null)` **0** · `schedule_mismatches()` **0** · `capacity_invariant_violations(null, true)` **0** · `rt-` fixture retailers **0** · ledger rows ≥ 0073: **10** (`0073`–`0082`; production will carry nine, 0074–0082).

## 7. Production (read-only facts, not re-verified by this packet)

Code `32e1418`; ledger `0060`–`0072`; holds ON; venues and contacts as in §1. The cutover's Part C §1 requires a fresh baseline before the window; nothing in this packet reuses the 12 September zero-booking snapshot as current.

## 8. Gates

| Gate | Status |
|---|---|
| CI run on `32a6d9d` (`clean_build=true`, `staging_gate=true`, `upgrade_rehearsal=true`) | **35175919223** — https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35175919223 — suites ✓ ubuntu (14 s) ✓ windows (31 s); clean build, both staging passes and the rehearsal await David's `staging` approvals |
| suites (ubuntu, windows) | ✓ ubuntu (14 s), ✓ windows (31 s) on `32a6d9d` |
| clean build A/B | awaits David's `staging` approval (was ✓ on `ad4f1ed`, whose migration chain this candidate shares) |
| staging pass 1, pass 2 (consecutive, same commit) | await David's `staging` approval (were ✓ ✓ on `ad4f1ed`; re-run because the payment source changed) |
| upgrade rehearsal 0072 → head | awaits David's `staging` approval (was ✓ on `5bafed9`; no migration changed since) |

## 9. Operator-owned, in order (David)

1. Approve the `staging` gates on the run above; results appended here.
2. Credential rotation (test-DB password → `SB_DB_URL` + GitHub `STAGING_DB_URL`; rebuild-check service key → `SB_KEY` + `STAGING_SB_KEY`; Stripe test key) and environment-binding confirmation.
3. Authorized deployed preview → the Stripe test-mode hold journey on this candidate: authorization, manual and automatic capture, release, expiry, worker overlap and replay, and the repaired error reporting (P-1/P-2 outcomes on the deployed handlers). Brand-profile access/editing, agreements and COI enforcement re-checked as smoke tests.
4. Approve Part C and the intended launch flags; execute the contained cutover; verify the deployment before enabling intake. Any production payment/refund smoke test is a separate explicit approval with identified test data and an agreed amount.

---

# Part C — Operator cutover runbook (v3)

_Verbatim copy of `release-b-cutover-runbook.md` v3 (demohub-docs commit `d1d7701`)._

**Applies to:** the Release B candidate named in the closure packet (branch `feature/release-b-slots-blackouts`). Production today: code `32e1418` (`53961d7` plus the `/gussmarket` redirect), migration ledger `0060`–`0072` (0073 never applied), holds ON, no customer bookings recorded as of the last read — **to be re-read at cutover, never assumed**.
**v3, for Codex's launch-groundwork decision (2026-09-16), section 4.** The v2 "quiet cutover" is withdrawn on four points: pending unleased fulfilment was allowed into the window although old code can claim it later; waiting for a lease to expire was treated as proof that an invocation had ended; the abort path could leave old code running against the changed contract; and the claim that a failed post-condition rolls back its whole file is false for 0074 (its `COMMIT` precedes its post-condition block). This version is an **empty-work, contained switch**: nothing old may run against the new contract at any point, intake is restored last, and every failure path stays contained.
**Ground rules:** every step that touches production is David's (or a named operator he authorizes). Nothing here deletes or resets data. Migrations are forward-only; an applied file is never edited. No `db push` against production. No production payment, refund or email is exercised by this runbook. Every Vercel directive says **Production** and whether a redeploy is needed. Any nonzero count in a gate is explained and resolved on its own terms; it is never emptied by approving, declining, cancelling or deleting anything to reach zero.

---

## 0. What the old build does, and why "quiet" has to be established rather than assumed

1. **The removed completion RPC is not an effects fence.** A `32e1418` worker (the fulfilment drain inside `refund-worker` and inside the webhook, the confirm route, the COI auto-confirm) creates the calendar demo and sends the emails **before** it calls the six-argument `complete_fulfillment`. After 0078 that call fails, but the demo and the emails have already happened, and on the next claim the work is repeated. A failed completion cannot undo effects.
2. **Neither holds-OFF nor checkout-OFF is a worker fence.** `PROVISIONAL_HOLDS_ENABLED=false` stops new held bookings; `CHECKOUT_ENABLED=false` stops new Checkout Sessions. Neither stops `refund-worker` (which drains fulfilment every tick regardless), `provisional-sweep`, the webhook, the confirm route or the COI approval. A Checkout Session created before the flag flipped can still be paid within 24 h and its webhook still runs the old handler and its inline fulfilment drain.
3. **A lease is not an invocation.** Fulfilment leases are 180 s and refund/case leases 120 s; an expired lease says nothing about whether the function that held it has finished — and a Vercel function can outlive the lease. "No unexpired lease" is therefore not evidence that old work has ended; §3 checks expired claims and recent activity too.
4. **Scheduling can be stopped; running code and incoming webhooks cannot.** Vercel's project setting **Disable Cron Jobs** stops the scheduler ([Vercel: manage cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). It does not end an invocation already running and it does not stop Stripe from delivering events. Those two are covered by §3's activity checks and by §5's event-safety rule.

## 1. Authorization (David) — before anything is touched

Record, in the deploy note, the exact: production target (`dkgjvsstbgnhcfboqqnd`, identity confirmed via `get_deployment_identity` = production), candidate SHA, migration list (**nine new versions, 0074–0082; 0073 stays absent by design**), maintenance window (start/end, Pacific and UTC), named operator for alerts and reconciliation during and after the switch, and the final flag values for launch (`CHECKOUT_ENABLED`, `PROVISIONAL_HOLDS_ENABLED`, `NOTIFICATION_WORKER_ENABLED`, `SLOT_EDITING_ENABLED`).

Prerequisites that must be **done** before the window opens: credential rotation (test-DB password, rebuild-check service key, Stripe test key) and the deployed-preview hold journey on the candidate (packet §9). A fresh production baseline (§3's query set, run once now, kept as "before") — not the 12 September zero-booking snapshot.

## 2. Containment — enter the window

All four, in this order, each recorded with a timestamp in the deploy note.

1. **Stop new intake.** Vercel **Production** env: `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false`; `NOTIFICATION_WORKER_ENABLED` and `SLOT_EDITING_ENABLED` stay unset. Redeploy `main` (the same old build, flags only). Confirm `/api/checkout` answers 503 and the booking page reports checkout unavailable.
2. **Freeze operators.** Nobody uses the Gus admin or the owner console for the window: no confirm/decline/cancel, no COI decisions, no venue, schedule or team edits. Tell Gus in writing; pick a time the stores are closed (early morning Pacific). The `/owner` and `/r/gus/admin` sessions stay logged out for the duration.
3. **Stop scheduling.** In the Vercel project settings, turn on **Disable Cron Jobs** (Production). Record the time. This stops future ticks of `refund-worker`, `provisional-sweep`, `notification-worker`, `coi-enforcement`, `brand-account`, `seed-demo`. It does not end a tick that is already running: the next step proves that.
4. **Account for what exists.** Open Checkout Sessions (brand mid-checkout), live holds, provider operations in flight, webhook events mid-handler, running worker invocations. §3 lists each with a query; none is cleared by operator action.

## 3. The empty-work gate (read-only; run after §2, and **again immediately before §4.1**; both outputs into the deploy note)

Run in the SQL editor for **demohub-prod**. Every row is a **stop condition** unless the table says otherwise.

```sql
-- A. work that old code could claim or continue
select 'open_checkout_attempts' k, count(*) n from payment_attempts where status = 'open'
union all select 'unsettled_groups', count(*) from payment_groups where status in ('pending','session_created')
union all select 'authorized_holds', count(*) from bookings where payment_status = 'authorized'
union all select 'held_bookings', count(*) from bookings where status = 'held'
union all select 'pending_payment_bookings', count(*) from bookings where status = 'pending_payment'
union all select 'fulfillments_pending', count(*) from booking_fulfillments where status = 'pending'
union all select 'fulfillments_failed_unresolved', count(*) from booking_fulfillments f where f.status = 'failed' and exists (select 1 from reconciliation_cases c where c.dedupe_key = 'fulfil:' || f.booking_id::text and c.resolved_at is null)
union all select 'fulfillment_claims_any', count(*) from booking_fulfillments where lease_owner is not null            -- live OR expired: an expired claim is not proof its holder stopped
union all select 'refund_requests_in_progress', count(*) from refund_requests where status in ('requires_review','reserved','submitted','pending','requires_action')
union all select 'refund_operations_in_progress', count(*) from refund_operations where status in ('open','requires_review')
union all select 'webhook_events_processing_any', count(*) from processed_stripe_events where status = 'processing'   -- live OR expired lease, same reason
union all select 'payment_uncertainty_open', count(*) from reconciliation_cases where resolved_at is null and (dedupe_key like 'capture-unknown:%' or dedupe_key like 'capture-unapplied:%' or dedupe_key like 'transition:%')
union all select 'open_reconciliation_cases', count(*) from reconciliation_cases where resolved_at is null;

-- B. is anything still RUNNING? (invocations outlive leases; a recent heartbeat or a recent row touch means an old function was active)
select cron_name, max(ran_at) last_ran_at, extract(epoch from now() - max(ran_at))::int age_s
from cron_heartbeat group by 1 order by 1;                                        -- every worker's last tick must predate the Disable Cron Jobs timestamp
select 'recent_fulfillment_touch' k, max(updated_at) t from booking_fulfillments
union all select 'recent_event_touch', max(processed_at) from processed_stripe_events
union all select 'recent_booking_touch', max(greatest(coalesce(paid_at, 'epoch'), coalesce(cancelled_at, 'epoch'))) from bookings;
select count(*) as db_activity_from_app from pg_stat_activity
 where datname = current_database() and application_name not in ('psql', 'Supabase Studio') and state <> 'idle' and pid <> pg_backend_pid();

-- C. the ledger, by exact version
select string_agg(version, ',' order by version) applied_since_0060 from supabase_migrations.schema_migrations where version >= '0060';
```

| Row | Meaning | Stop / allowed |
|---|---|---|
| `open_checkout_attempts`, `unsettled_groups` | a brand is mid-checkout; its session can still be paid and its webhook would run the OLD handler and inline drain | **stop** — wait for the session to complete or expire (≤ 24 h from creation). If it completes, the resulting work shows up in the rows below and is finished by the OLD build **before** the switch (re-enable cron, let it drain, re-disable, re-run this gate). |
| `authorized_holds`, `held_bookings`, `pending_payment_bookings` | a hold or a paid-but-unpromoted booking whose next transition is old-code work | **stop** — a hold resolves through Gus's decision or the 24 h sweep on the OLD build; a `pending_payment` row is promoted by the OLD worker. Let the old build finish them (cron re-enabled briefly, operators may act normally), then re-enter §2. Never decline/cancel to clear the count. |
| `fulfillments_pending`, `fulfillments_failed_unresolved` | queued or parked work old code could claim after the contract change | **stop** — same: drain with the OLD build; resolve a parked row's case by hand before the window |
| `fulfillment_claims_any`, `webhook_events_processing_any` | a claim exists, live or expired; the holder may still be running | **stop** — wait until both are zero; with cron disabled and intake off they clear themselves (a crashed holder's lease expires and nothing re-claims; a running holder finishes and releases). If a row stays claimed longer than 15 minutes after the disable timestamp, inspect it; do not clear it by hand. |
| `refund_requests_in_progress`, `refund_operations_in_progress` | unfinished money work | **stop** — let `refund-worker` reach a terminal state on the OLD build first |
| `payment_uncertainty_open` | an unresolved capture-unknown / capture-unapplied / transition case | **stop** — an operator resolves it (verify in Stripe, converge the ledger) before the window |
| `open_reconciliation_cases` (other kinds) | steady-state operator queue | allowed; list them in the note |
| section B | every worker's last heartbeat older than the disable timestamp; no row touched after it; no non-idle app connections | **stop** until true; wait ≥ 5 minutes after the disable timestamp (the longest function timeout) and re-run |
| section C | must read exactly `0060,…,0072` — no `0073`, nothing beyond | **stop** on any difference: reconcile the history first; never insert a version row that was not applied |

**If the gate cannot reach empty** (a real customer mid-flow that will not clear inside the window), **stop this simple cutover.** Restore §2's flags, re-enable cron, tell Gus, and schedule a compatible handover for that workload (a separately rehearsed procedure that keeps the old build fully functional while the new contract lands). Do not proceed because the cron interval or the window "looks large enough".

## 4. The switch — migrations, then the matching build, while contained

### 4.1 Migrations — exact versions, one file per run, verify, then record

Apply in the SQL editor for **demohub-prod**, each file pasted **whole as one run**. Transaction facts you must not get wrong: 0075–0077 wrap themselves in `BEGIN/COMMIT`; 0078–0082 have no explicit transaction and run as one implicit transaction when executed as a single batch; **0074's `COMMIT` comes before its post-condition block**, so a 0074 post-condition failure means the file's DDL **has already committed** — on any error, inspect what committed (the verify column below) before deciding anything. **`0073_demo_notifications` is omitted on purpose** — production never applied it and 0074 drops its table `IF EXISTS`; never insert a ledger row for it. The CI rehearsal replays exactly this sequence with 0073 absent (§7).

| # | Version · file | Verify before recording | Ledger row |
|---|---|---|---|
| 1 | `0074_release_a_schedule_and_outbox.sql` (`COMMIT` precedes its post-condition) | `select count(*) from information_schema.columns where table_name='bookings' and column_name in ('start_at','end_at','timezone')` → **3**; `select count(*) from notification_events` runs; `select to_regclass('public.demo_notifications')` → **null** | `insert into supabase_migrations.schema_migrations (version, name) values ('0074','release_a_schedule_and_outbox') on conflict do nothing;` |
| 2 | `0075_release_b_slots_blackouts.sql` | `select count(*) from venues where availability_version is null` → **0** | `… ('0075','release_b_slots_blackouts') …` |
| 3 | `0076_release_b_corrections.sql` | `select count(*) from offering_anomalies(null) where class='invariant'` → **0** | `… ('0076','release_b_corrections') …` |
| 4 | `0077_release_b_projection_and_transitions.sql` | `select to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')` → not null; `select count(*) from projection_anomalies(null)` → **0** | `… ('0077','release_b_projection_and_transitions') …` |
| 5 | `0078_release_b_fulfillment_generations_and_outcomes.sql` | `select to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')` → **null**; `select count(*) from booking_fulfillments where generation is null` → **0** | `… ('0078','release_b_fulfillment_generations_and_outcomes') …` |
| 6 | `0079_apply_all_copy_slots_default_false.sql` | `select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all'` contains `p_copy_slots boolean DEFAULT false` | `… ('0079','apply_all_copy_slots_default_false') …` |
| 7 | `0080_owner_booking_events.sql` | `select tgname from pg_trigger where tgname='trg_owner_booking_events'` → 1 row | `… ('0080','owner_booking_events') …` |
| 8 | `0081_fulfillment_terminalization_fence.sql` | `select to_regprocedure('public.open_fulfillment_case(uuid,text)')` → **null**; `select record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome'` → **stale** | `… ('0081','fulfillment_terminalization_fence') …` |
| 9 | `0082_backfill_active_booking_snapshots.sql` | `select count(*) from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date is not null and start_at is null` → **0**; read its NOTICE: if the gate was empty every count is 0; any "left NULL (trigger default)" count means a row was stamped with the 3 h default rather than its agreed length — list those rows for the operator | `… ('0082','backfill_active_booking_snapshots') …` |

Final check: `select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';` must read exactly `0074,0075,0076,0077,0078,0079,0080,0081,0082` — nine rows.

### 4.2 Deploy the matching build (still contained)

Merge the candidate to `main` and push (push = deploy). Confirm `/api/version` reports the candidate SHA. Containment stays in force: intake off, operators frozen, cron disabled.

## 5. Failure walkthrough — stay contained, inspect, fix forward

- **A file fails before 0078** (0074–0077): inspect what committed (the verify column; for 0074 the DDL is committed even when the post-condition raised). Nothing here removes an old-build contract, so the old build is still compatible. Do **not** continue; repair forward with a new migration under David's approval, keeping containment. If the repair cannot land in the window: leave the applied additive files in place, keep intake off until the window is re-scheduled, or restore intake **only** after confirming with a read of the old build's health probe and one synthetic read-only walk that the old build serves correctly on the additive schema.
- **0078 or later fails, or the deploy fails after 0078 landed**: the old build is now **incompatible** (its worker cannot complete rows, and repeats effects on retry). Containment must not be lifted and cron must not be re-enabled with the old build running. Repair forward (a new migration and/or a new candidate commit) and deploy the candidate; the emergency build is the corrected candidate itself with the optional switches off. Never redeploy `32e1418`/`53961d7` onto a schema at or past 0078, never apply a compatibility wrapper, never reset generation counters, never wipe.
- **Rollback semantics of the execution method:** the CLI rehearsal (§7) runs each file as a transaction and proved the sequence; the SQL editor runs the pasted batch as one implicit transaction **except** where a file carries its own `COMMIT` (0074–0077). Before the production window, rehearse the failure behaviour of the SQL-editor path once on demohub-rebuild-check: paste 0074 with a deliberately broken post-condition appended and confirm which objects remain; record the result in the deploy note. Do not rely on the CLI rehearsal for this.
- **Webhooks during the window:** the Stripe endpoint stays enabled and events stay durable: `claim_stripe_event` records each signed event before any handler runs, and a handler failure answers 5xx so Stripe retries for up to three days. With intake off and the §3 gate empty there is no Checkout Session that can complete, so no payment event can reach the old fulfilment path; a late non-payment event (refund updates, disputes) is claimed, fails on the old build if the contract changed, and is retried by Stripe onto the new build. If §3 could not be made empty, this rule does not hold — which is why §3 is a stop condition.

## 6. Verify with intake still off, then restore in order

### 6.1 Verify (read-only)

```sql
select * from projection_anomalies(null);                          -- 0 rows
select * from offering_anomalies(null) where class = 'invariant';  -- 0 rows
select * from snapshot_drift(null);                                -- 0 rows
select * from schedule_mismatches();                               -- 0 rows
select * from capacity_invariant_violations(null, true);           -- 0 rows
select status, generation, count(*) from booking_fulfillments group by 1,2;   -- nothing pending/claimed that predates the window
select dedupe_key, reason, created_at from reconciliation_cases where resolved_at is null order by created_at desc;  -- nothing new from the switch
select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';   -- the nine rows
```

`/api/version` = candidate SHA; `/api/find-retailer {action:'status'}` → db ok; environment binding = production (identity RPC); flags as set in §2. If 0082's NOTICE reported any default-duration rows, review them now with the operator.

### 6.2 Restore workers, then intake — in this order, each recorded

1. Vercel **Production** env: `NOTIFICATION_WORKER_ENABLED=true`, `SLOT_EDITING_ENABLED` per David's launch configuration; redeploy.
2. Turn **Disable Cron Jobs** off. Wait for one full tick of `refund-worker`, `provisional-sweep` and `notification-worker` on the **new** build: `cron_heartbeat` rows newer than the redeploy, `outcome` ok, and `notification_deliveries` / `booking_fulfillments` in the expected (empty or draining) state. Public status: `operational`, `notification-worker` required and ok.
3. Only then, Vercel **Production** env: `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED` per David's decision; redeploy. Confirm the booking page offers checkout. Lift the operator freeze; tell Gus.
4. Record completion: SHA, ledger rows with timestamps, both gate outputs, §6.1 outputs, flag values, cron re-enable time, and the named operator for alerts and reconciliation.

Any production payment or refund smoke test after launch is a separate, explicitly approved step with identified operator-owned test data and an agreed amount; it is not part of this runbook.

## 7. Rehearsal (staging, CI) — what it proves and its limits

The `verify.yml` job **`upgrade rehearsal 0072 -> head (staging)`** (dispatch input `upgrade_rehearsal=true`, `staging` approval) replays §4.1 on demohub-rebuild-check: reset with every migration ≥ 0073 hidden (ledger max 0072, 0073 absent, six-argument RPC present — `supabase/rehearsal/verify-pre.sql`), seed production-shaped rows through the product's own ledger RPCs (`seed-pre-0074.sql`), apply 0074–0082 with `supabase migration up --linked` while 0073 stays hidden, assert the exact ledger tail (`verify-ledger.sql`), then on the upgraded rows assert preserved state and snapshots (0082: every active row stamped from its slot, 1 h where the slot is 1 h), generation 1 on pre-existing outbox rows, all five audits clean, the contracts, and the runtime (claimless record → stale; claim returns generation 1; `promote_paid` then `confirm` project exactly one 1 h demo; wrong-generation record → stale) (`verify-post.sql`). It then captures the upgraded schema manifest, restores every file, resets staging to the full chain, captures the clean manifest and requires the two to match (documented normalization: the ledger count line and the 0073 listing row). Its first run found the 0074/0075 snapshot gap that became 0082. Artifact: `upgrade-rehearsal-evidence`.

What it does **not** prove: that production's activity is contained (that is §2–§3, operator work), the SQL-editor failure semantics (§5, rehearsed separately), or deployed-Vercel behaviour (the preview hold journey, packet §9).

## 8. Evidence to file with the deploy

Authorization record (§1); the fresh baseline; §2 timestamps (flags, freeze, cron disable); both §3 outputs with every nonzero row explained; the nine ledger rows with timestamps and the final tail query; 0082's NOTICE; `/api/version`; §6.1 outputs; the first new-build heartbeats; the §6.2 restore timestamps and final flags; the named operator; the CI run ids for the suites, clean build, both staging passes and the rehearsal; the SQL-editor failure rehearsal result.

