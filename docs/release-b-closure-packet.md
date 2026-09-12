# Demohub — Release B Closure Packet (round 4: Codex production-hotfix review, H1 … H3, on the combined candidate)

**Responds to:** Codex "production-hotfix review and bounded Claude handoff" (2026-09-12): C1, C3, C4 and most of C2 accepted; H1 (post-capture read failure), H2 (owner-alert delivery), H3 (agreement accessibility) ordered; integrate the production hotfixes into the branch; freeze one combined candidate; full gates on it.
**Supersedes:** every earlier Release B packet. This is the single packet for Release B.
**Prepared:** 2026-09-12 · **Branch:** `feature/release-b-slots-blackouts` · **Companion:** `release-b-cutover-runbook.md` (operator cutover, contract window, rollback/recovery), `release-b-round3-handoff-for-codex.md`, `Demohub-Prod-Wipe-Test-Brands-2026-09-12.sql` (executed wipe script, Part 3 results in §8).

---

## 1. Identity

| Item | Value |
|---|---|
| **Combined candidate SHA** | `f7d12974e59f57a2348978f8a7053217bd6921f4` — the branch head; every proof in §5–§6 is on this tree (the last two commits are test scoping and regenerated evidence; see §5 for the exact sequence) |
| Ancestry | round-3 candidate `7d6cccd` (C1–C4) ← merge of production `main` `53961d7` (`b0e3b2b`: the four hotfixes `9fa0854` signup category, `8df8828` owner alert, `84a6548` owner-alert copy review, `53961d7` agreement scroll box; conflicts resolved in `api/_fulfillment.js` — Release B worker kept, fulfilment-side owner hook dropped for H2 — and `package.json` — both test lists) ← `a26557e` H1 ← `20323bf` H2 (migration 0080) ← `54186de` H3 ← `140da9a` suite scoping ← `f7d1297` evidence |
| Migrations | 0000–0080 (**81** SQL files + README). New this round: `0080_owner_booking_events.sql`. CI `EXPECTED_MIGRATIONS: '81'`. |
| Test DB | demohub-rebuild-check (`tileejdviuvijumjeplv`): 0074–**0080** applied one file at a time in release order (ledger rows `0073`–`0080`) — this is also the rehearsal of the production upgrade sequence, with test data |
| Production | demohub-prod (`dkgjvsstbgnhcfboqqnd`, identity confirmed via `get_deployment_identity` = production): code `53961d7`; ledger `0060`–`0072`; **holds ON** (David's decision; acknowledged by Codex, not certified) |
| CI (this candidate) | run **34683529780** on `f7d1297`, dispatched with `clean_build=true`, `staging_gate=true` — suites in progress at packet time; the clean build and both consecutive staging passes need David's `staging` approval (§9) |
| Kill switches | `SLOT_EDITING_ENABLED` (default OFF; RPC `p_copy_slots` DEFAULT false since 0079) · `NOTIFICATION_WORKER_ENABLED` (Release A worker; now also carries the owner booking notice) |
| Containment | Gus only, signup OFF, capacity 1, no viewers, support OFF; holds ON (reported) |

## 2. Dispositions

### Preserved from rounds 2–3 (not reopened)

C1 generation fence + lease reset + generation-bearing claim/completion + stranded-payment audits (0078) · C2 hold cancel/decline convergence, capture-side auto-confirm convergence, refund-success/logical-refusal reconciliation · C3 `already_advanced` without downgrade · C4 missing/partial/reversed snapshot rejection with explicit both-NULL legacy · 0079 `p_copy_slots DEFAULT false` · signup category blank-only persistence (`9fa0854`, ancestor) · owner-email content/preview (mode-sensitive wording, actual deadline, snapshot-first occurrence, labelled legacy setting, escaping) · agreement modal (bounded box, reset-on-open, fit-to-content unlock, instant jump, signature guard). The suites that proved them re-ran green on this tree (§5).

### This round

| Item | Status | What changed | Proof |
|---|---|---|---|
| **H1 (P2)** post-capture read failure mislabels a charged, confirmed booking as a capacity failure | **Closed** | `api/booking-action.js`: the post-capture status read-back and its invented `pending` fallback are **removed**. After a capture the route goes straight to `booking_transition`, which judges the current row under lock (pending → confirmed, or `already_applied` when the capture-side auto-confirm got there first). Capacity was verified **before** the capture and is not re-checked, so the booking's own new demo can never count against it. If the transition throws or is logically refused after the capture, ONE deduplicated `settlement_exception` (`transition:<booking>`, reason `capture_succeeded_confirmation_unverified`) is recorded and the response is the distinct outcome `capture_succeeded_confirmation_unverified` with `captured: true`: "the brand's card WAS captured and this booking is being confirmed … do not decline it or ask the brand to rebook — refresh". No repeated capture, no refund. Admin: the thrown error carries the code; on this outcome the row is refreshed instead of left stale. | `fulfillment_lifecycle` H1 (real DB, spied Stripe): (a) slot full **before** the capture → 409 `slot_at_capacity`, **zero** capture calls, hold untouched; (b) auto-confirm OFF, transition injected to fail after the capture → 500 `capture_succeeded_confirmation_unverified`, one capture, zero refunds, booking paid + promoted, **no demo invented**, one case with the specific reason; the retry converges to 200 with exactly one demo and no second case; (c) auto-confirm ON → same outcome with the booking already confirmed and exactly **one** demo; a retry is refused truthfully as already confirmed, still one demo; (d) a poisoned status read is never consulted (0 read-backs), confirm succeeds. Codex's probe `demohub-hotfix-review-probes-2026-09-12.mjs` reproduces the defect at `7d6cccd` (both variants) and, pointed at this tree, cannot find the read-back block to reproduce (its own `assert(block.includes('select=status,payment_status'))` fails) — evidence that the path is gone, not re-coded. |
| **H2 (P2)** owner alert riding the brand-mail flag (missed fast capture / advanced booking, discarded failure, replay duplicates, unbounded before completion) | **Closed** | Migration **0080**: `notification_events.kind` admits `owner_booking_created`, `notification_deliveries.recipient_kind` admits `owner`, and trigger `trg_owner_booking_events` writes ONE event per booking (`transition_id` = booking id, UNIQUE) when `bookings.payment_status` first becomes `authorized` or `paid` — verified payment state, never `/api/book`; a captured hold is the same event; a grouped checkout yields one per child. The 0074 outbox delivers it unchanged: fan-out creates one delivery for the fixed owner address (skipping a booking already inactive); at dispatch the CURRENT booking decides the wording (hold vs paid, retailer's confirmation mode read fresh, snapshot-first occurrence), then payload + provider idempotency key are frozen exactly as for every other row — leases, bounded sends (10 s deadline), backoff, unknown-outcome handling, the 24 h dedupe-window stop, tenant checks. The fulfilment worker no longer sends owner mail (0078 worker untouched). `api/_owner-alerts.js` is the builder only; "paid and confirmed" no longer claims auto-confirm for a manual-confirm retailer. **Real guarantees stated:** one deduplicated booking event, controlled retries, recorded acceptance/uncertainty, visible terminal failures — not exactly-once inbox delivery. No lossy best-effort choice was made for David. | `owner_booking_events` (real DB, recording mailer with headers; **19/19**): unpaid/abandoned → no event · authorized hold → one event, one owner delivery, hold wording per the retailer's mode, key = delivery id · capture after the announce → still one event/one delivery · ordinary paid → paid notice; inserted paid+confirmed → "confirmed by the retailer" · capture before the held notice → ONE current paid notice, never an obsolete hold notice · rejected first attempt then capture → one accepted delivery, same frozen payload and key · accepted but completion stamp lost, replay → same key and subject to the provider, one row · manual confirmation before the notice → confirmed version · hold released / booking cancelled before the notice → explicit skip, no provider call, no demo · provider unreachable → UNKNOWN with retry, booking/payment untouched · past the 24 h window → final UNKNOWN surfaced, not resent · two bookings → two events with distinct keys. `owner_alert` builder 23/23. `notification_worker` 72/72 (scoped to its kinds). |
| **H3 (P3)** policy region without a tab stop or label; jump control vanished under focus | **Closed** | The scroll region has `tabindex=0`, `role=region`, an `aria-label`, and `aria-describedby` the hint; PageDown/arrow reading works. On unlock the jump control stays (disabled, relabelled "You reached the end"), the hint changes to "Policies read…", and focus moves to the checkbox when the box or the button had it. Reopen resets. The browser scroll flag is a UI courtesy, not server evidence of reading. | `agreement_modal.e2e` (real Chromium, desktop and phone with reduced motion; **18/18**): labelling, locked start with the modal fitting the viewport, PageDown scrolling of the focused region, early-accept guard, Enter on the jump → unlocked + focus on the checkbox + button kept, Shift+Tab lands on the signature field, reopen reset, fit-to-content unlock, no page errors. |

## 3. Design decisions for ratification

- **H1 returns 500** for the unverified-after-capture case (server-side uncertainty), 409 only when the transition was logically refused after the capture; both carry `captured: true`, the case id and `reconciliation_recorded`. The admin surfaces the message and refreshes.
- **H2 event source is a bookings trigger on `payment_status`**, not an edit of the payment RPCs: eligibility is exactly "the first verified money state", it fires for every path that sets that state (authorization, capture, ordinary payment, direct fixture inserts), and it is recoverable from durable booking state if fan-out lags.
- **Obsolete unsent owner work rule:** skipped at fan-out or dispatch when the booking is cancelled/declined/expired/auth-cancelled or its payment state is no longer authorized/paid; reasons are explicit (`booking_expired`, `booking_cancelled`, `booking_no_longer_unpaid`).
- **Frozen payload on a definite failure** is resent as frozen (the outbox's existing rule): a hold notice that failed and is retried after a capture still says "hold placed" — the booking was a hold when the event fired; the capture is not a second event.
- **Suites that count events** (`notification_worker`, `store_contact_notifications`, `reschedule_atomic`) now exclude the owner kind; the owner kind has its own suite.

## 4. Changed paths (this round)

`b0e3b2b` merge · `a26557e` `api/booking-action.js`, `r/gus/admin/index.html`, `tests/fulfillment_lifecycle.test.mjs` · `20323bf` `supabase/migrations/0080_owner_booking_events.sql` (new), `api/_notification-outbox.js`, `api/_owner-alerts.js`, `tests/owner_booking_events.test.mjs` (new), `tests/owner_alert.test.mjs`, `tests/notification_worker.test.mjs`, `package.json`, `.github/workflows/verify.yml` · `54186de` `r/gus/index.html`, `tests/agreement_modal.e2e.mjs` (new) · `140da9a` `tests/store_contact_notifications.test.mjs`, `tests/reschedule_atomic.test.mjs` · `f7d1297` `tests/evidence/stripe-testmode-grouped-2026-09-12.{md,png,png}`.

## 5. Test results — exact sequence (demohub-rebuild-check, 2026-09-12)

1. 0080 applied with its ledger row (after the merge, before any suite).
2. Focused regressions on the H1/H2/H3 tree: `fulfillment_lifecycle` **55/55** (incl. H1), `owner_booking_events` **19/19**, `owner_alert` **23/23**, `notification_worker` **72/72**, `agreement_modal.e2e` **18/18**.
3. Full battery on the same tree (`battery5.log`): `npm run check` (81 migrations, imports, no-undef over api/tools/tests, binding) ✓ · `npm test` (20 offline suites) ✓ · `check:columns` ✓ · `test:ledger` (fixtures 12, payment adversarial 63, holds adversarial 28, lifecycle 55) ✓ · `test:routes`: 8 of 9 green; `store_contact_notifications` 114/117 — its three failures were event-count assertions now seeing the owner event · `test:capacity` (35, 38, 97, 19, 117) ✓ · `test:live` (11, 21) ✓ · `reschedule_atomic` 46/50 — four event-count assertions for the same reason, plus one `schedule_mismatches()` row that did not recur (see below).
4. `140da9a` scopes those two suites to their own kinds; both re-run green (**117/117**, **50/50**, reschedule run three times in a row). The `schedule_mismatches()` row observed once was on a pair created by the reschedule suite while four of its own assertions had already failed (the B4/B5 block); it did not reproduce in three isolated runs after the scoping and is recorded here rather than explained away.
5. `admin_controls_dom.e2e` **52/52** on the merged tree.
6. `stripe_testmode_grouped.e2e` **88/88** on the final tree (evidence `tests/evidence/stripe-testmode-grouped-2026-09-12.md` + two PNGs, committed as `f7d1297`).
7. Codex's H1 probe: reproduces at `7d6cccd`; cannot reproduce on this tree (§2).

Labels: route suites run the shipped handlers in-process against the test database with provider spies; the Stripe journey is real test-mode Stripe for the paid path; the DOM and agreement suites are a real browser against the in-process server. None is a deployed-Vercel proof (§10). The real test-mode **hold** journey through the deployed handlers remains queued for the authorized preview (§10).

## 6. Audits (demohub-rebuild-check, after every suite above)

| Audit | Result |
|---|---|
| `offering_anomalies()` legacy / invariant | 0 / 0 |
| `snapshot_drift()` | 0 |
| `schedule_mismatches()` | 0 |
| `projection_anomalies()` (incl. `paid_booking_not_promoted`, `fulfillment_done_but_booking_not_promoted`) | 0 |
| `capacity_invariant_violations(NULL, true)` | 0 |
| owner deliveries left pending/claimed | 0 |
| fixture retailers left behind | 0 (two `rt-` route fixtures from earlier runs today were removed by hand; their venue rows had blocked the suite's own teardown — a test-hygiene fix to that teardown is queued for after acceptance so the candidate SHA stays frozen) |

## 7. Upgrade, contract window, rollback — see `release-b-cutover-runbook.md`

Order `0074 → 0075 → 0076 → 0077 → 0078 → 0079 → 0080`, each with its ledger row; `0073` omitted (never applied to production; 0074 drops its table `IF EXISTS`). The window between 0078 and the deploy is safe by construction (old worker can claim but cannot complete; leases expire ≤ 180 s; signed webhooks unaffected); deploy within minutes; optional intake pause via the holds flag. Rollback = this code with the kill switches unset; redeploying `53961d7` after 0078 is **not** a rollback; an emergency recovery script (generation-1-only six-argument completion) is kept **outside** the release in the runbook. Post-deploy verification queries are listed there.

## 8. Production preflight (read-only, 2026-09-12 08:30Z — re-read immediately before cutover)

active future bookings 0 · authorized holds 0 · paid/authorized groups 0 · pending fulfilments 0 · open reconciliation cases 0 · future demos linked 0 · future demos unlinked 10 (demo tenant) · brands 0 · build `53961d7`.

Test-data wipe (David, 2026-09-12 ~07:25Z): script `Demohub-Prod-Wipe-Test-Brands-2026-09-12.sql` (Documents/Codex; three parts: preview, one-transaction delete in dependency order, verify). Part 3 result as reported by David: bookings 0, brands 0, coi_verifications 0, demos 0, email_verifications 0, payment_groups 0, gus venues 5. Independent read-only re-check at 07:26Z: brands 0, bookings 0, payment_groups 0, demos-with-brand 0, gus venues 5, demo-tenant sample demos 10. Retained on purpose: the two COI PDFs in the `coi-docs` bucket — read-only check: bucket `public: false`, MIME-restricted, and 0049 declares/asserts private storage policies — and the Sept 3 Stripe charge/refund record.

## 9. GitHub gate

- Historical: `778ef1e` run 34579737286 (five jobs green); `7d6cccd` run 34659147025 (five jobs green).
- **`f7d1297`: run 34683529780** — dispatched with `clean_build=true`, `staging_gate=true`; suites in progress; the clean build and both consecutive staging passes require David's approval on the `staging` environment. Result to be appended; the SHA does not change unless Codex asks for changes.

## 10. Outstanding (operator-owned unless noted)

1. David approves the gates on run 34683529780; record the result.
2. Codex: accept/reject the combined candidate; no separate review round before the gates unless a design decision blocks.
3. Credential rotation (Codex §3 preflight).
4. Authorized deployed preview of `f7d1297` (existing Vercel project, test bindings, test Stripe, mail sink) — then (Claude) the real test-mode hold journey through the deployed handlers: authorization, manual/automatic capture, release, expiry, worker overlap, replay.
5. Cutover per the runbook: fresh preflight → 0074–0080 + ledger rows → deploy within minutes → env flags → verification queries → containment unchanged; holds flag is David's.
6. Queued test hygiene (after acceptance): route_flows teardown to delete fixture demos before venues.
