# Demohub — Release B Closure Handoff for Codex

**From:** Claude Code (David's build agent) · **To:** Codex · **Date:** 2026-09-11
**Subject:** Release B (configurable demo slots + blackout dates) — closure round R1–R7 + G1 delivered; request acceptance and the Release C work order.

---

## 1. What this handoff contains

1. **The consolidated closure packet** — `Demohub-Release-B-Closure-Packet.md` (same folder). One packet for all of Release B, as you required: B-01…B-08 (previous round) and R1–R7 + G1 (this round), each with the change, the proof, the audits, the upgrade/rollback plan, the production inventory and the CI record.
2. This cover note: what to look at first, what happened after the freeze, and the decisions that are yours.

## 2. Headline

- **Frozen candidate `778ef1e`** on `feature/release-b-slots-blackouts`. All seven review items and G1 are closed in code with runtime proof on demohub-rebuild-check.
- **CI verify #131 on `778ef1e`: all six jobs green** — suites on ubuntu + windows, clean build A/B, staging pass 1 and staging pass 2 (consecutive, same commit). David approved the `staging` environment.
- **Migration 0077** (forward-only) is the only schema change this round: the atomic `booking_transition` RPC, `booking_interval_ok`, `projection_anomalies()`, snapshot-returning `venue_blackouts_set`, and `p_copy_slots` on apply-all.
- Suites on the candidate: `release_b_corrections` 117/117, `admin_controls_dom.e2e` 52/52 (real Chromium, manager + owner), `public_slot_picker` 17/17 (new), `route_flows` 191/191, Stripe test-mode journey 88/88, every other suite unchanged and green. Five occurrence audits read 0 on the test DB.

## 3. Where each of your items landed (one line each; the packet has the detail)

| Item | Resolution |
|---|---|
| R1 | Apply-to-All confirm escapes the store name; two other interpolated modal messages escaped in the same audit; DOM test with a hostile name for manager and owner. |
| R2 | One transaction for status + demo projection (`booking_transition`), judged on the locked current row; handlers, webhook promotion/materialise and the fulfilment worker all use it; explicit `state_changed` / `superseded` results; honest retry semantics; `projection_anomalies()` audit. Barrier tests: parked stale cancel vs confirm, failure after refund → one deduplicated case and 500, retry atomic, replay idempotent. |
| R3 | Both calendar feeds answer 503 `no-store` when the snapshot lookup fails or is malformed; reconstruction only for demos without a booking, after a successful read. Brand feed's custom-duration event asserted in the Stripe journey. |
| R4 | `SLOT_EDITING_ENABLED` gates slot save/reset, blackouts, apply-all slot copying (`p_copy_slots`, enforced by the RPC too) and slot lists on venue creation. Proven through the API for unset / `"false"` / malformed / `"true"`. |
| R5 | Blackout responses carry each location's full availability snapshot; a stale tab's unsaved draft is discarded with a visible notice; two-tab DOM test. |
| R6 | Intervals crossing a daylight-saving change are refused by the DB (`booking_interval_ok`) and the route, and withheld by the public picker; the earlier "elapsed hours" acceptance is gone. |
| R7 | Every guard-bypass fixture is one short transaction, asserted enabled before/after, including a terminated connection. |
| G1 | Fixed on `accaefa1`; the CI staging pass then exposed a second fixture of the same kind (notification worker venue not offering 3:00 PM) — fixed in `1591d23`, and the green staging passes on `778ef1e` are the proof. |

## 4. Two things that happened after the freeze — recorded, not hidden

1. **Holds are ON in production.** David set `PROVISIONAL_HOLDS_ENABLED=true` (Vercel Production) on 2026-09-11 because the hard COI gate was a real friction point when he tested the brand flow. This widens the closed-launch envelope you set on 2026-09-03. The hold path was validated live on 2026-09-01 (both capture and release) and its adversarial suite runs in CI. Release B does not touch the hold code. Verified from the public status probe (`provisional-sweep` required and healthy).
2. **A production hotfix shipped and was merged into the branch.** `9fa0854` on `main`: the signup card's category is now persisted once at redeem (it rode a page-side follow-up that only ran on one signup surface) and a first booking saves its category to the profile, so the booking form stops asking "What are you demoing?" every time. `main` was merged into the branch with no conflicts → **deployable head `ba4909e`** = `778ef1e` + that hotfix. Following your stance that verification follows the change (no schema change, three lines on the public page outside the slot code, signup suite 21/21), the suites job was re-dispatched on `ba4909e`; the gated passes on `778ef1e` stand. Every proof in the packet was taken on `778ef1e`. If you want the full gate re-run on `ba4909e`, say so and David approves it.

## 5. Design decisions I made that you should ratify or reject

- **Kill switch read at request time.** `FLAGS.slotEditing` is a getter (same literal-`"true"` rule). Behaviour on Vercel is identical (env is fixed per deployment); the change lets the OFF matrix be proven in-process. The apply-all RPC enforces `p_copy_slots` itself, so no future caller can copy slots while the switch is off.
- **Fulfilment "superseded" is recorded as done.** A cancelled booking's outbox row is marked done with `error: superseded:…` rather than retried forever. No demo, no mail.
- **`demo_not_materialised` kept as a retryable guard** even though 0077 makes it unreachable.
- **Interval rule over "elapsed hours".** A slot that cannot keep its configured length on a date is not offered anywhere; nothing is stored with a different length than configured.
- **Route-suite teardown now removes ledger rows in FK order and prints failed deletes.** Earlier runs today had silently left fixture retailers behind; I removed five by hand on the test DB (documented in the packet) and the audits are clean.

## 6. Production plan (unchanged; needs your acceptance first)

1. David runs, in order, each with its ledger row: `0074` → `0075` → `0076` → `0077`. `0073` is omitted on purpose and must not be marked applied.
2. Merge the branch to `main` (push = deploy).
3. Vercel **Production**: `NOTIFICATION_WORKER_ENABLED=true`; `SLOT_EDITING_ENABLED=true` only when David wants Gus to edit slots and blackouts (enforcement is on regardless). Redeploy after env changes.
4. Verify the worker heartbeat and the five audits on production. Containment otherwise unchanged (Gus only, signup off, capacity 1, no viewers, support off; holds now on per §4).
5. Rollback = this code with `SLOT_EDITING_ENABLED` unset. Reverting to Release A code with 0075–0077 present is not compatible once any venue has custom slots.

Pre-deploy note: Gus received the booking link on 2026-09-11. The packet's "0 future active reservations" inventory should be re-read immediately before the migrations; 0075's backfill handles reservations that exist by then and B-04's preservation tests cover it.

## 7. Still owed by David (not code)

- Credential rotation from your §3 preflight (test-DB password, demohub-rebuild-check service key, Stripe test key).
- An authorized deployed preview if you still require a deployed-surface proof beyond the in-process browser evidence.
- Explicit confirmation of Option 2 before Release C activates it in production.

## 8. What I need from you

1. Accept or reject Release B on `778ef1e` / `ba4909e`, with any conditions.
2. Confirm the deploy sequence in §6, or amend it.
3. The Release C work order (Option 2 refund model, per your 2026-09-10 handoff): I will not start C until it arrives.

Reply through David as before; I will treat the next document as the work order.
