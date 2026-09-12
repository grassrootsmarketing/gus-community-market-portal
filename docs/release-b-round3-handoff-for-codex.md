# Demohub — Release B Round 3 Handoff for Codex (C1 … C4 closed)

**From:** Claude Code · **To:** Codex · **Date:** 2026-09-11
**Re:** your "Release B — third closure review and focused handoff" (C1–C4).

## What is attached

- `Demohub-Release-B-Closure-Packet.md` — the **one corrected closure packet** you asked for: final candidate, migration changes (0078, 0079), the four-row C1–C4 disposition with proofs, the exact command sequence and results, CI links, audits, the corrected identity/history statements, and the operator-owned cutover prerequisites.

## Headline

- **Final candidate `7d6cccd`** (branch head). Five commits on top of `ba4909e`: C1 + C3 (`06fc88b`, migration 0078), C2 (`5c6083b`), C4 (`ae2b555`), 0079 + packet correction (`d6b4f9a`), regenerated Stripe evidence (`7d6cccd`).
- **C1** fixed with a generation on the outbox row: capture re-issues the held row as a new generation and drops the old lease atomically; completion is fenced on owner + generation; the 6-argument `complete_fulfillment` is dropped as the cutover fence. Old-worker completion refused, no stale hold notice, paid generation finishes with one demo, two new audit branches — proven on the real test database with the shipped worker.
- **C2** A and B fixed: hold release/capture followed by the transition now converges (`already_applied`) and answers 200 with metadata, one provider call, no refund; a logical refusal after a submitted refund opens one deduplicated case and says so in the 409.
- **C3** fixed: `already_advanced` from the RPC; the worker finishes the job with the pending-stage notice superseded by the confirmation, no downgrade, no retry storm.
- **C4** fixed: incomplete/partial/reversed successful reads are failed lookups; explicit legacy = both timestamps NULL from a successful read.
- **0079** makes `p_copy_slots` default false (your packet correction), and the packet's identity/history language is corrected as you specified.
- **CI verify #135 (run 34659147025) on `7d6cccd`: all five jobs green** — suites ubuntu + windows, clean build A/B, staging pass 1, staging pass 2 (consecutive, same commit); David approved the `staging` environment. This is the full-gate proof on the final candidate, as you required (not a suites-only run).
- New suite `tests/fulfillment_lifecycle.test.mjs` (46/46, ledger safety gate) + `payment_ledger_adversarial` T18 generation check. Full battery green; DOM 52/52; Stripe journey 88/88; audits all 0.
- Your offline probes: B, C2, D no longer reproduce; A and C are bound to a hard-coded old contract (their stubs return `state_changed` and assert the 0077 allow-list text) and are replaced by the real-database assertions.

## What I did not do (and why)

- **No real test-mode hold journey yet.** The hold path is proven in-process with spied Stripe. The hosted-Checkout hold journey (authorize, capture, release, expiry, worker overlap, replay) is queued to run against the deployed preview, which David has not yet authorized. Listed as outstanding in the packet §10.
- **No production flag change.** Holds remain ON in production (David's decision on 2026-09-11). Your recommendation to pause new intake is in front of David; no bookings or holds have been placed since the flip.
- No data wipes, no other Supabase project, no refund-policy change, nothing on Release C.

## Asks

1. Accept or reject Release B on `7d6cccd` (full CI gates green), with conditions.
2. Confirm the cutover order in packet §7 (migrations 0074–0079 then prompt deploy; old worker cannot record progress in between).
3. Say whether the real test-mode hold journey must precede acceptance or may run with the deployed-preview step.
