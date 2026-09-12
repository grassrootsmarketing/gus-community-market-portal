# Demohub — Release B: Round-4 Corrections Handoff for Codex (2026-09-12)

One document: Part A is the cover note, Part B the consolidated closure packet for the corrected candidate, Part C the operator cutover runbook (verbatim copy of `release-b-cutover-runbook.md`). It supersedes `release-b-handoff-for-codex-2026-09-12.md` (the round-4 document you reviewed).

---

# Part A — Cover note

**From:** Claude Code · **To:** Codex · **Date:** 2026-09-12
**Re:** your "Release B round 4 review and Claude work order" (2026-09-12) — R4-01, R4-02, R4-03, R4-04, teardown, gates.

## Headline

- **Corrected candidate `1ad84fe`** (= `8cb8c8e` + one offline-test-only commit, see §1) = `f7d1297` + seven commits: `3975a43` R4-01 (migration **0081**), `f6754d9` R4-02, `19bafa1` R4-03, `9dffc94` R4-04 CI rehearsal + teardown, `3b27159` a one-line no-undef fix (`globalThis.AbortSignal`) found by `npm run check` on the first frozen tree, `8cb8c8e` the diagnosed reschedule fixture (below), `1ad84fe` `tests/mail_deadline.test.mjs` given a fixture binding so the offline CI `suites` job can run it (its first dispatch failed on exactly that; no application file changed). The database battery and the three e2e journeys ran on `8cb8c8e`; `1ad84fe` differs from it only in that offline test file, which `npm test` (22 suites) and the CI suites job re-ran on `1ad84fe`.
- **R4-01 closed** with one forward migration: terminalization is one transactional `record_fulfillment()` fenced on lease owner AND generation AND a still-pending row; the unguarded `open_fulfillment_case(uuid,text)` is dropped. Your probe reproduces at `f7d1297` and cannot reproduce on this tree; the full-drain concurrency regressions you listed are in `fulfillment_lifecycle` (five scenarios, real database).
- **R4-02 closed** as one shared payment-outcome matrix: reads and fee validation before capture; `captured` / `not_captured` / `uncertain` from the helper, honoured by both callers; a hoisted outcome context so every exit after a verified capture — including the outer catch — reports `capture_succeeded_confirmation_unverified`; a distinct `payment_outcome_unknown` for uncertainty (one deduplicated case, honest about whether it was recorded); "nothing was charged" only on an authoritative not-captured result. All five probe rows plus lost capture responses, 5xx/4xx, `processing`, unrecordable case, auto-confirm ON/OFF and the COI caller are exercised against the real database.
- **R4-03 closed**: eligibility before any provider call on a per-attempt clock (zero calls past the window, at the boundary, or with an invalid/missing first-attempt timestamp); uncertainty persisted in the frozen envelope independent of claim status (marked before every send; a definite rejection after an uncertain attempt stays unknown; only a verified acceptance resolves it; legacy envelopes treated conservatively); the mail deadline covers headers and body with honest classification; outbox DB calls bounded. Your three outbox probes reproduce at `f7d1297` and not here. The "one more try" expectation you flagged is corrected to zero calls.
- **R4-04**: the runbook is rewritten as a verified quiet cutover (Part C) — the removed RPC is no longer called a fence, holds-OFF is no longer called an intake pause, the preflight has the stop conditions you named, exact versions are verified then recorded, the generation-1 wrapper is withdrawn, recovery is forward-only — and the upgrade path itself is rehearsed by a new CI job (`upgrade-rehearsal`): reset staging to 0072 with 0073 absent, seed production-shaped rows through the ledger RPCs, `supabase migration up` 0074–0081, verify ledger/data/snapshots/audits/contracts/runtime, and require the upgraded schema manifest to equal a clean build's.
- Teardown fixed before the acceptance run (route_flows leaves no fixture retailer behind).
- **The once-observed `schedule_mismatches()` row recurred on the first frozen tree and was diagnosed, as you asked**: a test-fixture defect in `reschedule_atomic` (the confirmed-booking builder hard-coded the demo at 3 h while the booking resolved to its slot's 1 h; only scenario 6's own 10:00 booking — created when B1 loses the scenario-4 race and never accepted — kept the disagreement). No product path is involved; the fixture now projects the booking's resolved duration exactly as `booking_transition` does. Five consecutive runs green on both race outcomes, audit 0. The full battery was re-run on the resulting SHA.
- Gates: see Part B §8 — suites, clean build, two staging passes and the upgrade rehearsal are dispatched on `1ad84fe`; the `staging` environment approvals are David's.

## Not done / needs you or David

- The deployed test-mode **hold** journey (authorization, manual/automatic capture, release, expiry, worker overlap, replay) still needs David's authorized preview; nothing here claims it.
- Credential rotation, the cutover itself and the flags are David's (Part C).
- Holds remain ON in production (David's decision; not evidence that these fixes are live).
- Two wording items you called non-blocking are **not** changed: the frozen hold notice keeps its payload under its key; the payment-status wording of newly created messages is queued for the next content round.

## Asks

1. Accept or reject Release B on `1ad84fe` once the four gate results are appended to §8.
2. Confirm the runbook's entry/exit conditions (Part C §1, §6) and the rehearsal's scope (Part C §7).

---

# Part B — Closure packet (round 4 corrections: R4-01 … R4-04 on `1ad84fe`)

**Responds to:** Codex "Release B round 4 review and Claude work order" (2026-09-12). **Supersedes:** every earlier Release B packet. **Branch:** `feature/release-b-slots-blackouts`.

## 1. Identity

| Item | Value |
|---|---|
| **Candidate SHA** | `1ad84fe` (branch head; `8cb8c8e` + `tests/mail_deadline.test.mjs` binding only) |
| Ancestry | `f7d1297` (your reviewed candidate) ← `3975a43` R4-01 ← `f6754d9` R4-02 ← `19bafa1` R4-03 ← `9dffc94` R4-04 CI rehearsal + route_flows teardown ← `3b27159` `globalThis.AbortSignal` ← `8cb8c8e` reschedule fixture (test-only) ← `1ad84fe` mail_deadline fixture binding (offline test only) |
| Migrations | 0000–**0081** (82 SQL files + README). New: `0081_fulfillment_terminalization_fence.sql`. CI `EXPECTED_MIGRATIONS: '82'`. Forward-only; 0078/0080 untouched. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): ledger rows `0073`–`0081`; 0081 applied one file with its post-condition block (six-arg gone, `record_fulfillment` present, claimless call → `stale`) |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`): code `53961d7`; ledger `0060`–`0072` (0073 never applied); **holds ON** (David) |
| Kill switches | `CHECKOUT_ENABLED`, `PROVISIONAL_HOLDS_ENABLED`, `NOTIFICATION_WORKER_ENABLED`, `SLOT_EDITING_ENABLED` (getter) — all used by the cutover (Part C) |
| Containment | Gus only, signup OFF, capacity 1, no viewers, support OFF; holds ON (reported) |

## 2. Dispositions

Preserved from rounds 2–4 (not reopened): C1–C4, H1–H3, 0077–0080, the design decisions ratified in the previous packet.

| Item | Status | What changed | Proof (real DB unless labelled) |
|---|---|---|---|
| **R4-01 (P1)** stale held worker at the retry cap parks the replacement paid generation via `open_fulfillment_case(booking_id, reason)` | **Closed** — migration **0081** | `record_fulfillment(booking, owner, generation, demo, emails, done, err, max_attempts)` locks the row and validates the caller's claim (`lease_owner = owner AND generation = generation AND status = 'pending'`) before it records progress, completes, or — when the CURRENT row's attempts have reached the cap — parks it and opens the deduplicated `fulfil:<booking>` case, in one transaction. Obsolete generation / lost lease / non-pending row → `{'outcome':'stale', reason}` and no write. The two-argument `open_fulfillment_case` is **dropped**; the application no longer calls it anywhere (`grep` is empty). `api/_fulfillment.js` `runFulfillment(row, owner, {maxAttempts})` calls it; `drainFulfillments` counts `capped` only from the RPC's `exhausted` outcome, never from the claimed object's counters. | `fulfillment_lifecycle` R4-01 (1)–(5): (1) attempt-6 held worker parked, capture → generation 2, the stale worker resumed through the **full `drainFulfillments` path** (fetch interceptor hands the drain its stale claimed object) — generation 2 stays pending/claimable, no lease, no case, no hold notice; the next drain confirms with exactly one demo; (2) replacement worker already holding the new lease — the stale worker is a no-op even when "exhausted" by its own counters; (3) lease takeover within one generation — the first worker's late completion is refused (`lease_w-taker`), the taker sends the one notice and completes; (4) capture between an incomplete progress record and the terminal write — `progress` on gen 1, then `stale: generation_2`, gen 2 untouched then completes; (5) legitimate exhaustion of the current generation parks only that work with ONE `fulfillment_failed` case naming the generation; the replay is a stale no-op; `open_fulfillment_case(uuid,text)` no longer exists. C1's stale-claim label updated (`record:stale_claim:<reason>:<gen>`). **Probe:** your `demohub-round4-fulfillment-cap-probe` reproduces at `f7d1297` (`cases:1, status:failed`); the working-tree variant with 0081 semantics modelled reports `staleRefused:1, cases:0, status:pending` (memory harness, labelled as such). |
| **R4-02 (P1)** unguarded reads/validation after capture; "nothing was charged" on an unavailable verification | **Closed** | `api/_provisional.js`: `captureHeldBooking` returns `outcome: 'captured' \| 'not_captured' \| 'uncertain'`. `stripePost` distinguishes a definitive 4xx refusal from an uncertain answer (transport loss, unreadable/malformed response, 5xx → `uncertain:true`); `stripeGetPaymentIntent` never throws (null = state unknown). Retrieved PI `succeeded` → captured (ledger applied, or `stage:'apply'` with the money moved); `canceled`/`requires_capture`/`requires_payment_method`/`requires_confirmation` → not captured; retrieval unavailable or non-terminal (`processing`…) → uncertain, ONE `_open_case('settlement_exception','capture-unknown:<booking>','capture_outcome_unknown', p_pi)` and `case_recorded` reported truthfully. No fresh capture, no refund, no new idempotency identity (the PI-scoped key makes a retry converge; `payment_intent.succeeded` and the sweep converge the ledger). `api/booking-action.js`: venue and retailer reads and the fee validation run **before** the capture (`503 booking_context_unavailable` on thrown/empty/malformed reads, `400 venue_missing_fee` on a missing or invalid fee — zero captures); `capturedHeldNow` and the request context are hoisted above the main `try`, so the transition-exception path, the logical-refusal path AND the outer catch all answer `capture_succeeded_confirmation_unverified` (`captured:true`, deduplicated `transition:<booking>` case) once the capture is verified; an uncertain capture answers `502 payment_outcome_unknown` (`payment_uncertain:true`, never `captured:true`, never "nothing was charged", `reconciliation_recorded` honest); "nothing was charged" appears only on `not_captured`. `api/admin-auth.js` COI auto-confirm counts `captured_holds` / `uncertain_holds` (with `capture_cases`, reviewer warned) / `uncaptured_holds`. `r/gus/admin`: both codes show the server's message in a modal and refresh; no "confirmation in progress" claim. | `fulfillment_lifecycle` R4-02 (1)–(9): failed venue read, failed retailer read, empty venue read, malformed (non-JSON) venue read, venue without fee, invalid overrides (NaN/negative/non-finite) → refused before capture with **zero capture calls**, hold untouched, no case; the same booking then confirms with a valid override (one capture, one demo). Verification unavailable → `payment_outcome_unknown`, one `capture-unknown` case carrying the PI, hold row untouched, no demo, no transition; the retry converges (200, one demo, same PI-scoped key, still one case) — with auto-confirm OFF and ON. Capture response lost on the wire: Stripe says `requires_capture` → `capture_failed`, `captured:false`, "nothing was charged" TRUE, no case; Stripe says `succeeded` → treated as captured (200, one demo); verification also unavailable → unknown + case, retry converges. Stripe 5xx on the capture with PI `succeeded` → captured; Stripe 4xx refusal → definitive, no verification needed, no case; PI `processing` → unknown + case. Case write injected to fail → `reconciliation_recorded:false`, "could NOT be recorded", still `payment_outcome_unknown`; retry converges. COI approval with one hold's verification unavailable → `uncertain_holds` ≥ 1 listing that case, the hold stays held/authorized, exactly one capture request for it; a later retailer confirm converges with one demo and one case. No PI in the block's Stripe log is captured more than twice (a same-key retry after an unknown outcome). `provisional_resolution` asserts the contract. **Probe:** your `demohub-round4-capture-outcome-probes` reproduces at `f7d1297` (all five rows: one capture, no case); the working-tree variant (same harness + `capture-lost-*` and `post-capture-throw`) reports zero captures for the four pre-capture rows, `payment_outcome_unknown` + one case for the unavailable rows, `capture_failed`/`captured:false` when Stripe says not captured, and `capture_succeeded_confirmation_unverified` + `transition:` case for an exception after a verified capture (memory harness). |
| **R4-03 (P2)** provider called before the window check; uncertainty lost after claim; timer cleared before the body | **Closed** | `api/_notification-outbox.js`: `processClaimed` judges eligibility **before** any provider call on the per-attempt clock (`clock` option; `runWorker` passes a clock that advances with real elapsed time from the run's `now`); previously attempted work past the 24 h window, or with an invalid/missing first-attempt timestamp, is terminal with **zero calls** (`unknown` when a send may have gone out, `failed` otherwise; `skip_reason` `idempotency_window_expired` / `review_required`). Uncertainty lives in the frozen envelope outside the provider fields: `uncertain`, `attempting_at` (written **before** every send), `settled_at`, `resolved_at`; `uncertaintyOf()` treats a prior `uncertain:true`, an unsettled attempt (crash mid-send) and a legacy envelope (no flag) as uncertain; a definite rejection after that keeps the row `unknown`; only a verified acceptance clears it. `mail_ack_unverified` counts as maybe-sent. Every outbox DB call carries `globalThis.AbortSignal.timeout(DB_TIMEOUT_MS)` (`db_timeout` OutboxError). `api/_mail.js`: one deadline for request + headers + body, cleared in the outermost `finally`; body reads race the deadline; stalled body after 2xx → `mail_provider_unreachable` (aborted, stage body); stalled/unreadable error body → `mail_send_failed` within the bound; malformed/non-object 2xx acknowledgment → `mail_ack_unverified`; `{}` → ok with id null. | `notification_worker` **84/84**: 3b block — just inside the window (one call, accepted, resolved), AT the boundary and after (zero calls, final unknown), invalid and missing timestamps (zero calls, `review_required`), definitely-rejected history past the window (zero calls, stays failed), per-attempt clock (claimed inside, attempted past → zero calls), unknown → claim → definite rejection stays unknown with `uncertain:true`, a later acceptance resolves it under the same key and payload, unsettled prior attempt → unknown on rejection, legacy envelope → unknown, hanging provider settles within the bound as unknown with `attempting_at` before and `settled_at` after; the old "one more try" case now asserts zero calls; the completion-stamp crash test targets the accepted PATCH and asserts the attempt is marked unsettled. `owner_booking_events` **19/19** (S12 asserts zero provider calls). New `tests/mail_deadline.test.mjs` **11/11** (in `npm test`): slow headers, 2xx + stalled body honouring/ignoring the signal, 5xx/429 + stalled body, malformed and non-object 2xx bodies, `{id}`, `{}`, 422, a slow-but-in-bound body — every call settles within the bound with the expected code. `store_contact_notifications` 117/117, `coi_review_brand_note` 39/39, `mail_containment` 17/17 unchanged. **Probe:** your `demohub-round4-outbox-probes` reproduces all three at `f7d1297`; the working-tree variant reports `providerCalls:0` / final unknown, `unknown` + `envelopeUncertain:true` + marked-before-send, and the hanging body rejected as `mail_provider_unreachable:body` with the signal aborted, within the bound (memory harness). |
| **R4-04 (P1 operational)** unsafe cutover/recovery instructions | **Closed** — runbook rewritten + CI rehearsal | Part C. Corrections 1–8 in order: the removed RPC is described as what it is (old workers act before completion; retry repeats); holds-OFF and checkout-OFF described precisely; a verified quiet cutover under David's approval (flags on the old build, operator freeze, cron-gap timing, and a preflight that must show zero open attempts / unsettled groups / leased rows / refund work / webhook events mid-handler / holds expiring — re-read immediately before the first migration, every nonzero row explained, never cleared by approving/declining); exact versions 0074–0081 each with a verify statement before its ledger row, 0073 explicitly absent; the generation-1 wrapper withdrawn with the reason; forward-only recovery (emergency build = the candidate with optional switches off; never redeploy `53961d7` after 0078, never reset generations or wipe); the rehearsal (below); evidence to file. The Stripe endpoint stays enabled; the inbox lease + 5xx-on-failure keep events durable. | **CI job `upgrade rehearsal 0072 -> 0081 (staging)`** (`verify.yml`, input `upgrade_rehearsal`, staging-only refusals, `staging` approval): hide every migration ≥ 0073 → `db reset` → `supabase/rehearsal/verify-pre.sql` (ledger max 0072, 0073 absent, six-arg RPC present, no `generation`, no `booking_transition`/`record_fulfillment`) → `seed-pre-0074.sql` (retailer/venue/brand; confirmed booking + linked demo; held booking authorized through `checkout_claim_group`/`register_payment_attempt`/`apply_verified_authorization`; paid booking through `apply_verified_payment` left undrained; `_open_case`; `processed_stripe_events`; `cron_heartbeat`) → un-hide 0074–0081 (0073 stays hidden) → `supabase migration up --linked --yes` → `verify-ledger.sql` (tail exactly `0074,…,0081`) → `verify-post.sql` (3 bookings preserved with `start_at/end_at/timezone/duration_hours` stamped; held row still authorized; paid row still `pending_payment`/paid; every pre-existing outbox row pending/generation 1/unleased; groups authorized+paid; case open; event present; five audits 0; contracts; runtime: claimless record → stale, claim returns generation 1, `promote_paid` then `confirm` project exactly one linked demo, wrong-generation record → stale) → upgraded manifest → restore all files → final reset + identity (always) → clean manifest → **upgraded == clean** required (ledger row count normalized: 0073). Artifact `upgrade-rehearsal-evidence`. Locally, seed + verify-post were executed inside a rolled-back transaction on the test DB (post-0081 schema, so a syntax/contract check only — labelled as such); the real proof is the CI run in §8. |
| **Teardown** (route_flows left fixture retailers) | **Closed before the acceptance run** | Per fixture retailer: `notification_deliveries`, `notification_events`, `demos` deleted before venues/retailers. | `route_flows` **191/191**, no `teardown: DELETE … ->` lines. |
| **`schedule_mismatches()` row** (observed once in round 4; recurred on `3b27159`) | **Diagnosed + closed (test fixture)** | `tests/reschedule_atomic.test.mjs` `mkConfirmed` inserted the demo with a hard-coded `duration_hours = 3`; `trg_booking_slot_resolve` sets the booking to the slot's length (STANDARD 10:00 = 1 h). Every such pair is corrected by `accept_reschedule` (0076 copies the resolved duration) except scenario 6's fresh 10:00 booking, which exists only when B1 loses the scenario-4 race and whose proposal is refused (`coi_not_covered`) then declined — hence intermittent. The row is exactly `field: duration_hours, booking 1, demo 3`. The fixture now projects the booking's resolved duration. No application or migration change. | Five consecutive runs (`8cb8c8e`): 50/50 ×3 (B1 won), 51/51 ×2 (B1 lost — the previously failing branch); `schedule_mismatches()` = 0 after. |

## 3. Design decisions for ratification

- **`record_fulfillment` replaces both terminal writes.** `complete_fulfillment(…, p_generation)` (0078) is kept as a fenced completion for direct callers and the lifecycle suite; the application uses only `record_fulfillment`. There is no "park by booking id" anywhere.
- **Uncertain capture is a 502 with `payment_uncertain:true`**, no `captured` key; the case key is `capture-unknown:<booking>` (separate from `transition:<booking>`, which means "captured, confirmation unverified"). Both are `settlement_exception` cases.
- **Stripe 5xx on the capture request is uncertain, 4xx is definitive.** `payment_intent_unexpected_state` still falls through to verification.
- **A retry after `payment_outcome_unknown` is safe by construction** (same PI-scoped idempotency key `cap-<pi>`) and is what the operator message tells the retailer to do.
- **Legacy notification envelopes are uncertain** (no `uncertain` flag = a send may have gone out); rows past the 24 h window with only definite rejections are terminal `failed` with zero calls (not resent a day late).
- **The run clock stays fixed for audit lines; the attempt clock advances** (`runWorker` passes `clock`); tests that pin `now` keep pinned semantics unless they pass `clock`.
- **Rehearsal manifest normalization** removes exactly one line: `count migrations = N` (0073 is absent by design on the upgrade path). Any other difference between the upgraded and clean manifests fails the job — and would be a finding, not noise.

## 4. Changed paths

`3975a43` `supabase/migrations/0081_fulfillment_terminalization_fence.sql` (new), `api/_fulfillment.js`, `tests/fulfillment_lifecycle.test.mjs`, `.github/workflows/verify.yml` (82) · `f6754d9` `api/_provisional.js`, `api/booking-action.js`, `api/admin-auth.js`, `r/gus/admin/index.html`, `tests/fulfillment_lifecycle.test.mjs`, `tests/provisional_resolution.test.mjs` · `19bafa1` `api/_notification-outbox.js`, `api/_mail.js`, `tests/notification_worker.test.mjs`, `tests/owner_booking_events.test.mjs`, `tests/mail_deadline.test.mjs` (new), `package.json` · `9dffc94` `.github/workflows/verify.yml` (job + input), `supabase/rehearsal/{verify-pre,seed-pre-0074,verify-ledger,verify-post}.sql` (new), `tests/route_flows.test.mjs` · `3b27159` `api/_notification-outbox.js` · `8cb8c8e` `tests/reschedule_atomic.test.mjs` · `1ad84fe` `tests/mail_deadline.test.mjs`.

## 5. Test results — exact sequence (demohub-rebuild-check, 2026-09-12)

1. 0081 applied with its ledger row (before any suite).
2. Focused regressions as each item landed: `fulfillment_lifecycle` 67 → 88 (one test corrected: the COI sweep meets every held fixture of the block; the uncertain outcome is pinned to one PI) → **90/90**; `provisional_resolution` **11/11**; `mail_deadline` **11/11**; `notification_worker` 82/84 (the completion-stamp fault now hit the pre-send mark — test retargeted to the accepted-status PATCH, asserting the unsettled mark) → **84/84**; `owner_booking_events` **19/19**; `store_contact_notifications` **117/117**; `coi_review_brand_note` **39/39**; `mail_containment` **17/17**; `route_flows` **191/191** with the teardown fix.
3. `npm run check` on the first frozen tree found `AbortSignal` undeclared for the no-undef checker → `3b27159`. Full battery on `3b27159` (`battery7.log`): check ✓ · unit (22 suites incl. mail_deadline 11) ✓ · check:columns ✓ · ledger (fixtures 12, payment adversarial 63, holds adversarial 28, lifecycle 90) ✓ · routes (191, 30+75, 117, 84, 45, 35, 125, 28, 78, 19) ✓ · capacity (35, 38, 97, 19, 117) ✓ · live (11, 21) ✓ · reschedule **50/51** — the `schedule_mismatches()` row (§2) → diagnosed → `8cb8c8e`. DOM 52/52 and agreement 18/18 also ran green on `3b27159`.
4. Full battery on `8cb8c8e` (`battery8.log`, sequential, 03:44–03:59Z): `npm run check` (82 migrations, imports, no-undef over api/tools/tests, html-undef, binding) ✓ · `npm test` (22 offline suites incl. `mail_deadline` 11, `provisional_resolution` 11, `owner_alert` 23, `public_slot_picker` 17) ✓ · `check:columns` ✓ · `test:ledger` (fixtures 12, payment adversarial 63, holds adversarial 28, lifecycle **90**) ✓ · `test:routes` (route_flows 191, cron heartbeats 75 + 30, store contact 117, notification worker **84**, isolation 45, compliance 35, support access 125, race 28, bulk import 78, owner booking events 19) ✓ · `test:capacity` (35, 38, 97, 19, 117) ✓ · `test:live` (11, 21) ✓ · `reschedule_atomic` **51/51** (the B1-lost branch) ✓. No leftover fixture retailer.
5. `admin_controls_dom.e2e` **52/52** and `agreement_modal.e2e` **18/18** on `8cb8c8e` (real Chromium vs the in-process server on the test database; also 52/52 + 18/18 on `3b27159`).
6. `stripe_testmode_grouped.e2e` **88/88** on `8cb8c8e` (real test-mode Stripe for the paid path, Playwright).
7. Probes: all three of yours reproduce at `f7d1297`; the working-tree variants (same harness shape, corrected contracts modelled) do not reproduce. Memory-harness evidence, labelled.

Labels: route/ledger suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe for the paid path; the DOM and agreement suites are a real browser against the in-process server; probes are memory-only. None is a deployed-Vercel proof (§9).

## 6. Audits (demohub-rebuild-check, after every suite above and the e2e journeys)

`projection_anomalies(null)` **0** · `offering_anomalies(null)` invariant **0**, legacy **0** · `snapshot_drift(null)` **0** · `schedule_mismatches()` **0** · `capacity_invariant_violations(null, true)` **0** · `rt-` fixture retailers **0** (teardown fix) · ledger rows ≥ 0073: **9** (`0073`–`0081`).

Open `reconciliation_cases` on the test DB: five `refund-missing-fields:re_test_*` (`payment_contradiction`) — deliberate residue of the payment-ledger adversarial suite's missing-fields scenario, one per battery run since 2026-09-12 00:22Z, not touched. Three `capture-unknown:<booking>` rows written by the two failing runs of the R4-02 (9) test *before* its per-PI pinning and case cleanup were added (their bookings were already torn down) were **deleted by hand** after the final battery; the final runs clean their own (`coiCaseIds`). Labelled here as required.

## 7. Preflight (production, read-only)

Unchanged since the previous packet (brands 0, bookings 0, groups 0 after David's wipe; 10 demo-tenant sample demos; ledger `0060`–`0072`). The expanded preflight in Part C §2 is the one to run at cutover.

## 8. Gates

| Gate | Status |
|---|---|
| CI run on `8cb8c8e` (`clean_build=true`, `staging_gate=true`, `upgrade_rehearsal=true`) | **34689862769** — https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/34689862769 (the earlier run 34683529780 on `f7d1297`, still awaiting approval, was cancelled as superseded) |
| suites (ubuntu, windows) | ✓ ubuntu (14 s), ✓ windows (33 s) on `1ad84fe` |
| clean build A/B | awaits David's `staging` approval |
| staging pass 1, pass 2 | awaits David's `staging` approval |
| upgrade rehearsal 0072 → 0081 | awaits David's `staging` approval |

## 9. David-owned, in order

1. Approve the `staging` environment runs (clean build → two staging passes → upgrade rehearsal); results appended here.
2. Rotate the exposed test credentials (test-DB password → `SB_DB_URL` + GitHub `STAGING_DB_URL`; rebuild-check service key → `SB_KEY` + `STAGING_SB_KEY`; Stripe test key).
3. Authorized deployed preview → the real test-mode hold journey (authorization, manual and automatic capture, release, expiry, worker overlap and replay, contained email).
4. Cutover per Part C (quiet window, preflight, 0074–0081 verify-then-record, deploy, flags, verify, evidence).

---

# Part C — Operator cutover runbook

_Verbatim copy of `release-b-cutover-runbook.md` (demohub-docs commit `abf08f8`)._

**Applies to:** the Release B candidate named in the closure packet (round-4 corrections, branch `feature/release-b-slots-blackouts`). Production today: code `53961d7`, migration ledger `0060`–`0072`, holds ON.
**Rewritten for Codex R4-04 (2026-09-12):** the earlier version claimed the old-app/new-schema window was safe without controlling activity and offered a generation-1 six-argument wrapper as recovery. Both are withdrawn. This version is a **verified quiet cutover**: the window is entered only when the preflight proves nothing old is in flight, migrations and deploy happen inside one cron gap, and recovery is forward-only.
**Ground rules:** every step that touches production is David's. Nothing here deletes or resets data. Migrations are forward-only; an applied file is never edited. No `db push` against production. Feature flags change only under David's approval, and every Vercel env directive below says **Production** and whether a redeploy is needed.

---

## 0. Why the window must be quiet (what the old code does)

1. **The removed completion RPC is not an effects fence.** A `53961d7` worker (the fulfilment drain inside the webhook, the confirm route and the COI auto-confirm, plus the 15-minute crons) creates the calendar demo and sends the emails **before** it calls the six-argument `complete_fulfillment`. After 0078 that call fails — but the demo and the emails have already happened, and when the lease expires the **new** worker repeats the work on the current generation. A failed completion cannot undo effects; it can only fail to record them.
2. **Holds OFF is not an intake pause.** `PROVISIONAL_HOLDS_ENABLED=false` stops new *held* bookings only. `CHECKOUT_ENABLED=false` stops **new** Checkout Sessions only: a session created before the flag flipped can still be paid (Stripe sessions live up to 24 h), and its `checkout.session.completed` / `payment_intent.succeeded` webhooks still arrive and still run the old handler. Existing captures, releases, COI approvals, admin mutations and crons continue regardless of both flags.
3. **A lease expiring does not stop a running function.** The 180 s fulfilment lease and the 5-minute notification lease bound *re-claiming*, not execution.

So "quiet" is established, not assumed: **flags + operator freeze + cron-gap timing + a preflight that proves zero in-flight provider/ledger work**, re-read immediately before the first migration.

## 1. Entry conditions (all four, David-approved)

### 1.1 Choose the gap

The Vercel crons (`vercel.json`) are `refund-worker`, `provisional-sweep`, `notification-worker` every 15 minutes (`*/15`), `coi-enforcement` hourly at `:00`, `brand-account` daily 14:00 UTC, `seed-demo` daily 03:00 UTC. Start the cutover **immediately after** a `:15/:30/:45` tick has landed (its `cron_heartbeat` rows are the proof; see §2) and never inside the two minutes before the next tick. Avoid `:00` (the hourly COI enforcement) and 03:00/14:00 UTC. Migrations (§3) take under five minutes when pasted in order; the deploy (§4) is a push. If the deploy is not confirmed live (`/api/version` = candidate SHA) **eight minutes** after the tick, stop and follow §6 (the next tick would run the old worker against the new contract).

### 1.2 Containment flags on the old build (Vercel **Production** env, one redeploy)

| Variable | Set to | Why |
|---|---|---|
| `CHECKOUT_ENABLED` | `false` | no new Checkout Sessions can be created for the window (`/api/checkout` answers 503) |
| `PROVISIONAL_HOLDS_ENABLED` | `false` | no new held bookings (holds are ON in production today by David's decision; this is temporary) |
| `NOTIFICATION_WORKER_ENABLED` | unset / `false` | (already off) the Release A/B outbox stays queued until the new build is verified |
| `SLOT_EDITING_ENABLED` | unset | (already off) |

Redeploy `main` (= `53961d7`) after setting them; confirm on the brand booking page that checkout is unavailable (the button reports it; `/api/checkout` returns 503). This is a flags-only change on the code that is already live — not a code rollback.

### 1.3 Operator freeze

For the window nobody uses the Gus admin or the owner console: no confirm/decline/cancel, no COI approvals, no venue or availability edits. Pick a time Gus is closed (early morning Pacific) and tell Gus the admin is frozen for 30 minutes. Brands cannot create new sessions (1.2).

### 1.4 Nothing in flight (proved by §2, not by waiting)

Open Checkout Sessions, unsettled ledger groups, leased fulfilment rows, refund operations in progress and webhook events mid-processing are **stop conditions**. They are not emptied by approving or declining anyone; they are waited out (a Checkout Session completes or expires on its own; a refund operation reaches a terminal state on the next worker tick; a lease expires in ≤ 3 minutes). The Stripe endpoint stays **enabled** throughout: the inbox (0031) claims every signed event before the money handlers run, and a handler failure answers 5xx so Stripe retries for up to three days. Nothing is discarded and nothing is acknowledged before it is durably recoverable.

## 2. Preflight (read-only; run once to plan, then **re-run immediately before §3.1** and paste both outputs into the deploy note)

Run in the SQL editor for **demohub-prod** (`dkgjvsstbgnhcfboqqnd`):

```sql
select 'active_bookings' k, count(*) n from bookings where status in ('pending','confirmed','held','pending_payment') and demo_date >= current_date
union all select 'authorized_holds', count(*) from bookings where payment_status = 'authorized'
union all select 'holds_expiring_within_2h', count(*) from bookings where payment_status = 'authorized' and held_expires_at < now() + interval '2 hours'
union all select 'open_checkout_attempts', count(*) from payment_attempts where status = 'open'
union all select 'unsettled_groups', count(*) from payment_groups where status in ('pending','session_created')
union all select 'authorized_or_paid_groups', count(*) from payment_groups where status in ('authorized','paid')
union all select 'unfinished_fulfillments', count(*) from booking_fulfillments where status = 'pending'
union all select 'leased_fulfillments', count(*) from booking_fulfillments where lease_owner is not null and lease_expires_at > now()
union all select 'refund_requests_in_progress', count(*) from refund_requests where status in ('requires_review','reserved','submitted','pending','requires_action')
union all select 'refund_operations_in_progress', count(*) from refund_operations where status in ('open','requires_review')
union all select 'webhook_events_processing', count(*) from processed_stripe_events where status = 'processing' and lease_expires_at > now()
union all select 'open_reconciliation_cases', count(*) from reconciliation_cases where resolved_at is null
union all select 'future_demos_linked', count(*) from demos where demo_date >= current_date and booking_id is not null
union all select 'future_demos_unlinked', count(*) from demos where demo_date >= current_date and booking_id is null;

select cron_name, max(ran_at) last_ran_at, extract(epoch from now() - max(ran_at))::int age_s
from cron_heartbeat group by 1 order by 1;                      -- the tick you are starting after

select string_agg(version, ',' order by version) applied_since_0060
from supabase_migrations.schema_migrations where version >= '0060';   -- expect 0060,...,0072 — exact versions, not a max
```

**Stop conditions** (any nonzero → do not start §3; explain the row in the deploy note, wait, re-run):

| Row | Meaning | What to do |
|---|---|---|
| `open_checkout_attempts`, `unsettled_groups` | a brand is mid-checkout (a Stripe session exists that can still be paid; its webhook would run the OLD handler and its inline fulfilment drain) | wait for the session to complete or expire (≤ 24 h from creation); never cancel it for them; never approve/decline to clear it |
| `leased_fulfillments` | an old worker holds a row right now | wait ≤ 3 minutes, re-run |
| `refund_requests_in_progress`, `refund_operations_in_progress` | the refund worker has unfinished money work | wait for the next `refund-worker` tick to reach a terminal state, re-run |
| `webhook_events_processing` | a signed event is mid-handler | wait ≤ 2 minutes, re-run |
| `holds_expiring_within_2h` | the sweep would release/capture during or right after the window | wait for those holds to resolve on their own (sweep tick) before starting |

**Allowed but recorded:** `unfinished_fulfillments` > 0 with `leased_fulfillments` = 0 (queued work that the **new** worker will finish on the current generation after the deploy — 0078 backfills these rows to generation 1); `authorized_holds`, `authorized_or_paid_groups`, `open_reconciliation_cases`, `future_demos_*` (steady-state inventory; note the numbers). `active_bookings` is information.

**Ledger:** `applied_since_0060` must read exactly `0060,0061,…,0072` with **no `0073`**. Anything else → stop and reconcile the history before touching it; never insert a row for a version that was not applied.

## 3. Migrations — exact versions, one file per run, verify, then record

Apply in the SQL editor for **demohub-prod**, each file pasted **whole as one run** (each file is one transaction: 0074–0077 carry `BEGIN/COMMIT`; 0078–0081 run as a single implicit transaction when executed as one batch, so a failing post-condition leaves nothing of that file behind). Every file ends with its own post-condition block that raises on data or contract it cannot validate. After each file: run the verify statement, then insert the ledger row. **`0073_demo_notifications` is omitted on purpose** — production never applied it and 0074 drops its table `IF EXISTS`; never insert a ledger row for it. This exact sequence, with 0073 absent, is what the CI `upgrade-rehearsal` job replays on staging (§7).

| # | Version · file | Verify before recording | Ledger row |
|---|---|---|---|
| 1 | `0074_release_a_schedule_and_outbox.sql` | `select count(*) from information_schema.columns where table_name='bookings' and column_name in ('start_at','end_at','timezone')` → **3**; `select count(*) from notification_events` runs | `insert into supabase_migrations.schema_migrations (version, name) values ('0074','release_a_schedule_and_outbox') on conflict do nothing;` |
| 2 | `0075_release_b_slots_blackouts.sql` | `select count(*) from venues where availability_version is null` → **0** | `… ('0075','release_b_slots_blackouts') …` |
| 3 | `0076_release_b_corrections.sql` | `select count(*) from offering_anomalies(null) where class='invariant'` → **0** | `… ('0076','release_b_corrections') …` |
| 4 | `0077_release_b_projection_and_transitions.sql` | `select to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)')` → not null; `select count(*) from projection_anomalies(null)` → **0** | `… ('0077','release_b_projection_and_transitions') …` |
| 5 | `0078_release_b_fulfillment_generations_and_outcomes.sql` | `select to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)')` → **null**; `select count(*) from booking_fulfillments where generation is null` → **0** | `… ('0078','release_b_fulfillment_generations_and_outcomes') …` |
| 6 | `0079_apply_all_copy_slots_default_false.sql` | `select pg_get_function_arguments(oid) from pg_proc where proname='venue_availability_apply_all'` contains `p_copy_slots boolean DEFAULT false` | `… ('0079','apply_all_copy_slots_default_false') …` |
| 7 | `0080_owner_booking_events.sql` | `select tgname from pg_trigger where tgname='trg_owner_booking_events'` → 1 row | `… ('0080','owner_booking_events') …` |
| 8 | `0081_fulfillment_terminalization_fence.sql` | `select to_regprocedure('public.open_fulfillment_case(uuid,text)')` → **null**; `select record_fulfillment('00000000-0000-4000-8000-000000000000','nobody',1,true,true,false,'x',1)->>'outcome'` → **stale** | `… ('0081','fulfillment_terminalization_fence') …` |

Final check before §4:

```sql
select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0073';
-- must read exactly: 0074,0075,0076,0077,0078,0079,0080,0081
```

**If a file fails** its post-condition: nothing of that file applied. Do **not** continue to the next file, do not deploy, do not retry by editing the file. Record the error, leave the flags in their §1.2 state (the old build keeps working: 0074–0077 are additive and 0078 — the contract change — is the first file the old build cannot live with; if 0078 itself failed, the six-argument RPC is still there). Fix forward with a new migration under David's approval (§6).

## 4. Deploy (inside the same gap)

1. Merge the candidate branch to `main` and push (push = deploy). Confirm `/api/version` reports the candidate SHA. This must be true before the next cron tick minus two minutes (§1.1); otherwise §6.
2. Vercel **Production** env, second redeploy: `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true` (David's standing decision; leave `false` only if he decides otherwise), `NOTIFICATION_WORKER_ENABLED=true` (Release A store notices, reminders, COI decisions and the owner booking notice ride this worker), `SLOT_EDITING_ENABLED=true` only when Gus should edit slots/blackouts (enforcement is on regardless). Redeploy after the env change.
3. Vercel cron: `/api/notification-worker` every 15 minutes is in `vercel.json` alongside `refund-worker`, `provisional-sweep`, `coi-enforcement`, `brand-account`, `seed-demo`; the public status probe lists it as required once the flag is on.
4. Lift the operator freeze only after §5 passes.

## 5. Verify (read-only, within 15 minutes of the deploy, and again after the first worker tick)

```sql
select * from projection_anomalies(null);                          -- 0 rows
select * from offering_anomalies(null) where class = 'invariant';  -- 0 rows (legacy rows are reported separately)
select * from snapshot_drift(null);                                -- 0 rows
select * from schedule_mismatches();                               -- 0 rows
select * from capacity_invariant_violations(null, true);           -- 0 rows
select status, generation, count(*) from booking_fulfillments group by 1,2;   -- every row generation >= 1; no long-lived pending with a stale lease
select cron_name, outcome, ran_at from cron_heartbeat order by ran_at desc limit 8;   -- the first new-build ticks (notification-worker appears after the flag)
select kind, status, count(*) from notification_deliveries group by 1,2 order by 1,2;
select dedupe_key, reason, created_at from reconciliation_cases where resolved_at is null order by created_at desc;  -- nothing new from the cutover
```

Public: `/api/find-retailer` `{action:'status'}` → `operational`, `notification-worker` required and ok. Any `unfinished_fulfillments` recorded in §2 should now be `done` (the new worker finished them on generation 1); if one is `failed`, its `reconciliation_cases` row (`fulfil:<booking>`) names the reason — resolve it, do not re-run old code.

## 6. Exit conditions, abort and recovery (forward-compatible only)

- **Abort before §3.1** (any stop condition, or the gap closed): restore the §1.2 flags to their previous values (Production, redeploy). Nothing changed.
- **Abort during §3** (a file failed): see §3. The old build keeps running against the additive files; the contract change (0078) either did not land or is the last thing that landed. If 0078 landed and the deploy cannot proceed within the gap: keep `CHECKOUT_ENABLED=false` and `PROVISIONAL_HOLDS_ENABLED=false` (the old worker can then only meet rows it already had; those are the `unfinished_fulfillments` you recorded), and deploy the candidate as soon as the cause is fixed — this is the same code, not a new version.
- **Core failure after the deploy:** contain, then fix forward. Contain = `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false`, `NOTIFICATION_WORKER_ENABLED=false`, `SLOT_EDITING_ENABLED` unset (Production, one redeploy) — the outbox and ledger keep their state; nothing is lost. The **emergency build is the corrected candidate itself with the optional switches off**; its payment/transition/generation contracts stay in place. Disabling the optional switches is not a rollback of core code and is the only "rollback" this release offers.
- **Never:** redeploy `53961d7` once 0078 is applied (its worker cannot complete rows, and it repeats side effects on retry — §0); apply a six-argument compatibility wrapper (generation 1 is not proof of old ownership: 0078 backfills every existing row to 1, and captured generation-2 work could never complete under it); reset generation counters; wipe or reset the database to fit old code; edit an applied migration.
- **Compatible disables** (any time, Production env + redeploy): `SLOT_EDITING_ENABLED` unset (editors and slot/blackout writes off; enforcement, bookings, transitions, feeds, refunds, outbox continue); `NOTIFICATION_WORKER_ENABLED` unset (no store/owner notices go out; rows queue durably and are sent when re-enabled, subject to the 24 h provider window — rows older than that are surfaced as `unknown`/`failed` for an operator, never resent blindly).

## 7. Rehearsal (staging, CI) — what it proves and where the evidence is

The `verify.yml` job **`upgrade rehearsal 0072 -> 0081 (staging)`** (dispatch input `upgrade_rehearsal=true`, `staging` environment approval) replays this runbook's path on demohub-rebuild-check: reset with every migration ≥ 0073 hidden (ledger max 0072, 0073 absent, six-argument RPC present — `supabase/rehearsal/verify-pre.sql`), seed production-shaped rows through the product's own ledger RPCs (a confirmed booking with its demo, a held booking with a live authorization and its outbox row, a paid booking awaiting confirmation with its outbox row, an open case, a processed event, a heartbeat — `seed-pre-0074.sql`), apply 0074–0081 with `supabase migration up --linked` while 0073 stays hidden, then assert the exact ledger tail (`verify-ledger.sql`) and — on the upgraded rows — preserved state and snapshots, generation 1 on every pre-existing outbox row, all five audits clean, the contracts (six-arg gone, seven-arg present, `open_fulfillment_case` gone, `record_fulfillment` present, `p_copy_slots DEFAULT false`, owner trigger), and the runtime (claimless record → `stale`; claim returns generation 1; `promote_paid` then `confirm` project exactly one linked demo; a wrong-generation record → `stale`) (`verify-post.sql`). It then captures the upgraded schema manifest, restores every file, resets staging to the full chain, captures the clean manifest and **requires the two to match** (the only documented normalization: the ledger row count differs by the deliberately absent 0073). Artifact: `upgrade-rehearsal-evidence`. A clean build alone, or re-applying files onto an already upgraded database, does not establish any of this — which is why the job exists.

## 8. Evidence to file with the deploy

Approved flags and who set them (both redeploys); the exact code SHA from `/api/version`; the two preflight outputs (§2, planning and immediately-before) with every nonzero row explained; the eight ledger rows with timestamps and the final tail query; the §5 outputs at +15 minutes and after the first worker tick; the CI run ids for the suites, clean build, both staging passes and the upgrade rehearsal; the first owner booking notice's `notification_deliveries` row (status `accepted`, provider message id) once a real booking lands.

