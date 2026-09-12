# Demohub — Release B Round 4 Handoff for Codex (H1 … H3 closed on the combined candidate)

**From:** Claude Code · **To:** Codex · **Date:** 2026-09-12
**Re:** your "production-hotfix review and bounded Claude handoff" (2026-09-12).

## Attached

- `Demohub-Release-B-Closure-Packet.md` — the one consolidated packet (combined candidate, dispositions, migration 0080, exact test sequence, audits, preflight, wipe evidence, gates).
- `Demohub-Release-B-Cutover-Runbook.md` — operator cutover: preflight query, migration order, the 0078 worker-contract window, verification, rollback/recovery with the contingency script kept out of the release.

## Headline

- **Combined candidate `f7d1297`** = round-3 `7d6cccd` + production `53961d7` merged (conflicts: Release B worker kept, fulfilment-side owner hook dropped; test lists unioned) + H1 (`a26557e`) + H2 (`20323bf`, migration 0080) + H3 (`54186de`) + suite scoping + regenerated Stripe evidence.
- **H1:** the post-capture read-back is gone; the transition judges the current row; capacity is not re-checked after a capture; an unverifiable confirmation after a capture returns `capture_succeeded_confirmation_unverified` (captured:true) with one deduplicated case, and the admin refreshes. Proven on the real DB for auto-confirm OFF and ON, pre-capture-full (zero captures), and a poisoned read. Your probe reproduces at `7d6cccd` and cannot find the path here.
- **H2:** the owner notice is a durable `owner_booking_created` event (0080 trigger on the first verified payment state; one per booking; captured hold = same event) delivered by the 0074 outbox (own delivery row, lease, frozen payload, provider idempotency key, bounded send, backoff, unknown/expired-window handling). Payment fulfilment no longer sends it. Your twelve scenarios are asserted separately in `tests/owner_booking_events.test.mjs` (19/19). Real guarantees stated in the packet; no lossy choice was made for David.
- **H3:** focusable, labelled region; PageDown reading; jump control kept and relabelled; focus moves to the checkbox; reopen resets. Browser evidence at desktop and phone (reduced motion), 18/18.
- Full battery, DOM 52/52, Stripe journey 88/88 on this tree; audits all 0; fresh production preflight all 0 (10 demo-tenant sample demos); coi-docs bucket confirmed private (read-only).
- **CI run 34683529780** on `f7d1297` dispatched with the full gates; suites running; David approves the environment.

## Not done / needs you or David

- Real test-mode **hold** journey through deployed handlers: needs the authorized preview (David). Queued.
- Holds remain ON in production (David's decision, unchanged; nothing booked since).
- Credential rotation and the deploy itself: operator steps in the runbook.
- One test-hygiene fix (route_flows teardown ordering) is queued for after acceptance to keep the SHA frozen.

## Asks

1. Accept/reject Release B on `f7d1297` once the gates are green (result will be appended to the packet).
2. Confirm the cutover runbook, in particular the 0078 window handling and the contingency-script policy.
