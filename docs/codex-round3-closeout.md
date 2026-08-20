# Demohub — Codex Round 3 Close-Out (for independent re-evaluation)

**Date:** 2026-08-20
**Repository:** `grassrootsmarketing/gus-community-market-portal`
**Release commit under review:** `c842414` on `main` (pushed, Vercel-deployed)
**Prior evaluation this responds to:** `Demohub-Codex-Pentest-Evaluation-2026-08-20.md` (reviewed `1197754`)

## How to read this

The prior evaluation returned **NO-GO for live launch with provisional holds enabled**, with a
conditional safe path: a **closed Gus's launch with `PROVISIONAL_HOLDS_ENABLED` OFF** after P0-3,
P0-4, P0-5, the stale route tests, and the CI/main evidence gate were corrected and two consecutive
full staging runs passed.

David chose to fix **all** findings (including the P0-1/P0-2 race redesigns' *code*), while leaving
the flag decision to launch day. This document states, per finding: the fix, the exact location, and
**how to independently verify it** — separating what is *proven in fact* from what is *code-fixed but
deliberately not yet adversarially proven on real Stripe* (and therefore kept dark).

**Launch posture:** `PROVISIONAL_HOLDS_ENABLED` is **OFF**. The closed-launch blockers are closed and
proven. The provisional-holds code path is not exercised in production.

## Verify the evidence yourself

Offline (no DB), from the repo root:
```
npm run check      # migration/import/undefined/binding checks — expects 68 migrations
npm test           # unit + route-mocks + the new round-3 guard tests
```
Against staging (real DB; ref `tileejdviuvijumjeplv`; REST creds in `C:\Users\David\demohub.env`):
```
set -a; . /c/Users/David/demohub.env; set +a
npm run check:columns      # every SQL/JS column ref vs live schema
npm run test:routes        # drives the ACTUAL handlers against staging
npm run test:live
LEDGER_TARGET_REF=tileejdviuvijumjeplv ALLOW_STAGING_LEDGER_TESTS=yes node tests/payment_ledger_adversarial.mjs
```
**Result on `c842414` (run twice, consecutive, same commit):** column checks ✓; route flows **182/0**;
live entitlements **11/0**; live flows **21/0**; adversarial ledger **62/0**. CI (`verify.yml`) ran on
the `main` push and **passed**.

Migration `0067` is applied to **staging AND prod**; its in-migration postcondition
(`P0-4: atomic COI review proven; probe rolled back`) executed on both.

---

## Findings — disposition

### P0-3 — HIGH: generic retailer proxy bypassed payment/compliance transitions — **CLOSED, proven**
**Fix:** `api/admin.js` — removed `bookings` (and `demos`, which nothing writes through the proxy)
from `ALLOWED_TABLES`; added a per-table **operation** allowlist `TABLE_WRITE_OPS` enforced before any
write (405 `operation_not_allowed` otherwise). Booking reads still flow through the authenticated
`action=data` response. Every booking mutation and COI-waiver change must use its dedicated route
(`booking-action.js`, `refund-review.js`, `coi-status.js`).
**Verify:** `tests/admin_table_guard.test.mjs` (offline, in `npm test`) proves `bookings`/`demos` are
not writable and that the shipped frontend never routed a booking/demo write through the proxy. On
staging, `PATCH /api/admin?table=bookings` now returns 400 `invalid or missing table parameter`.
**Attack to retry:** a manager session trying `{"status":"cancelled"}` or `{"coi_waived_at":…}` via
`/api/admin?table=bookings`.

### P0-4 — COI approval and reviewer expiry were not atomic — **CLOSED, proven**
**Fix:** `supabase/migrations/0067_coi_review_atomic_expiry.sql` extends `review_coi_verification` to
take `p_expiry`, validate it (required + future for approvals), and commit — in ONE transaction — the
immutable decision, the verification record's `policy_expiry`, the brand's verification status, and
`brands.default_coi_expires`. The 4-arg signature is dropped so no caller can approve without the
expiry. `api/admin-auth.js` (owner-coi-review) passes `p_expiry` and the best-effort post-approval
PATCH is removed.
**Verify:** the migration's postcondition proves a no-expiry approval is refused *and inert*, and a
valid approval commits decision + brand status + brand expiry + record expiry together. On staging,
`tests/route_flows.test.mjs` now asserts the expiry persists atomically on both the brand and the
verification record (these were the tests failing before `0067`; now 182/0).

### P0-5 — Brand COI View link did not use the authorized file route — **CLOSED**
**Fix:** `brand/dashboard/index.html` — the View link now points at
`/api/coi-file?brand_id=${p.id}` (authenticated, no-store redirect to a short-lived signed URL),
matching the retailer workflow, instead of embedding the bare storage path.
**Verify:** `api/coi-file.js` denies other-brand and unauthenticated requests (covered on staging in
`route_flows` section 9). Re-run the acceptance test from the prior eval (upload → fresh login →
View → deny cross-brand / anon).

### Evidence & release-gate defects — **CLOSED, proven**
- `EXPECTED_MIGRATIONS` `62 → 68` in `.github/workflows/verify.yml`; the file count assertion now
  passes (68 files).
- `verify.yml` now triggers on `main` (push + PR), not only `clean/**`/`launch/**`. Confirmed: the
  `c842414` push produced a **green** `verify` run on `main`.
- `main` now has branch protection: required checks `suites (windows-latest)` + `suites
  (ubuntu-latest)`, `strict=false`, `enforce_admins=false` (solo push-to-deploy preserved).
- COI review route fixtures updated to supply the reviewer expiry (the stale-fixture failure the prior
  eval hit). Two consecutive full green staging runs recorded on `c842414`.
- New provisional/authz tests added to `npm test`: `admin_table_guard`, `provisional_resolution`.

### P0-1 — HIGH: capture/release race — **CODE-FIXED; holds-ON validation deliberately deferred**
**Money-loss defect closed in code** (`api/_provisional.js`): `releaseHeldBooking` no longer calls
`apply_authorization_canceled` unconditionally after a `payment_intent_unexpected_state` cancel. It
**re-fetches the PaymentIntent and converges on Stripe's authoritative state**: `succeeded` → converge
the ledger to PAID (via the shared `applyCapturedPi`, reusing `apply_verified_payment`, idempotent);
`canceled` → release; anything else → retryable, stays held. All three callers handle the new
`was_captured` outcome so none terminalizes a now-paid booking: `provisional-sweep.js` records it and
skips; `booking-action.js` decline/cancel returns `hold_captured` (409) rather than marking a charged
booking declined; `book.js` bump lets the now-paid row drop out of the `status=eq.held` re-query.
`api/stripe-webhook.js` `handlePaymentIntentSucceeded` now reconciles **any non-settled** group (not
just `authorized`) and **never silently acks a captured PI** — a captured PI on a non-payable group
opens a reconciliation case.
**Verify:** `tests/provisional_resolution.test.mjs` locks the fix shape (offline, in `npm test`); the
existing ledger/reconciliation coverage passes on staging (62/0).
**NOT yet done (required before `PROVISIONAL_HOLDS_ENABLED=true`), see `docs/provisional-holds.md`:**
(1) a capacity-reservation lease in a locking RPC; (2) a DB-owned resolution lease so only capture OR
release contacts Stripe; (3) **adversarial interleaving proven against real Stripe test-mode
authorizations** (capture-vs-sweep, capture-vs-decline, capture-vs-bump; webhook replay/out-of-order
across `authorized`/`auth_canceled`). Because the flag is OFF, this path is dark in production.

### P0-2 — HIGH: held payment captured before capacity validated — **CODE-FIXED; lease deferred**
**Fix:** `api/booking-action.js` — a shared `slotCapacityStatus()` is checked **before**
`captureHeldBooking`; a full slot returns `slot_at_capacity` with **nothing charged**. The
post-capture check remains for the normal paid-confirm path.
**Residual (holds-ON only):** the pre-capture count is not a lock — two simultaneous confirms can both
pass it. The locking capacity RPC in the P0-1 list above is required before the flag goes ON. Dark
while OFF.

---

## Bottom line for the reviewer

- **Closed launch, holds OFF (the prior eval's recommended path): all blockers closed and proven** —
  P0-3, P0-4, P0-5, the stale fixtures, the CI/main/branch-protection evidence gate, and two
  consecutive full green staging runs on `c842414`.
- **Holds ON: not claimed.** P0-1/P0-2 have code fixes that close the money-loss defects and are
  locked by tests, but the two lease RPCs and the real-Stripe adversarial interleaving proof the prior
  eval demanded are **explicitly outstanding** and the flag is **OFF**. Do not read this document as a
  claim that provisional holds are launch-ready.

Please re-audit `c842414`. The highest-value places to push remain `api/_provisional.js`,
`api/stripe-webhook.js`, and `api/admin.js`, plus the `0067` RPC for any partial-commit path.
