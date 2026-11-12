# Acceptance annotation for preview-transport-2026-11-11-r8.json (round 8, Codex R7-2)

Written 2026-11-12 after Codex's round 8 response (Documents/Codex/Demohub-Connected-Checkout-Round-8-Response-2026-11-11.md). The recorded result in preview-transport-2026-11-11-r8.json is NOT edited; this note sits beside it.

## The failed assertion

phases.recovery, the fourth check of --mode=recovery-run (2026-11-12T04:57Z, Preview deployment of 55ecc91, endpoint we_1UWZDNA6b3orPg0ToTQaJm2v disabled from 04:56:44Z to 04:57:33Z): "the DEPLOYED worker did the settlement work (its counters show it) ...". It is recorded as failed and stays failed.

Why it failed: the runner captured the worker's HTTP answer under the refund resubmission counters (resubmitted, adopted, reconciled), which are 0 on the settlement path, instead of the settlement block's counters (settlement_claimed, settlement_completed). Every provider and ledger condition of the same check was true in the recorded data: the request fcd85dd6-3266-42b2-a05b-1faea362fcdd went from settlement pending with zero attempts and no fee refund (phases.recovery.before) to complete with one attempt, fee refund fr_1Uaq4RAuAgpJei71ar0RDm6L of 1000 under the request's metadata and the reversal trr_1Uaq4GA6b3orPg0Te1OTuFrv of 16000 verified (phases.recovery.after_first), and the second invocation changed nothing (phases.recovery.after_second).

## The evidence that resolves it

phases.recovery.heartbeats_in_window, read by --mode=recovery-verify (04:59:54Z) from cron_heartbeat on demohub-rebuild-check, the rows the deployed worker writes itself at the end of every invocation:

- ae560e58-e5b5-460c-9d77-c1ecec6effee, ran_at 04:57:13.87Z, duration 3184 ms (started about 04:57:10.7Z): settlement claimed 1, completed 1, retried 0, exceptions 0, errors 0, outcome succeeded. The fee refund was created at 04:57:12Z, inside this window.
- 3d9085ce-6e84-4691-85cb-ce4399bb9222, ran_at 04:57:16.88Z, duration 1118 ms: settlement claimed 0, completed 0, errors 0, outcome succeeded.

The third check of recovery-verify asserts exactly this and passed. No other actor could have created the fee refund: apply_refund_event is a database function and cannot call Stripe, the cancel route never ran, no test endpoint was enabled during the pause (phases.recovery.endpoint_during_pause) and the refund event evt_3Uaq3RA6b3orPg0T0noclp8V still has no inbox row (phases.recovery.after_restore).

## Codex's acceptance

Round 8 response, section "R7-2, Closed with the evidence discrepancy preserved": the runner's fourth assertion must remain recorded as failed; its use of customer-refund counters instead of settlement counters is a test-reporting error; the independently recorded server heartbeat and the matching provider and ledger transitions resolve the substantive question; no new financial run is required solely to replace this counter assertion. The runner now reads the settlement counters and the full body for any future run (commit 9629f98).
