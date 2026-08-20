# Demohub — Closed-Launch Final Evidence Packet

**Date:** 2026-08-20
**Repository:** `grassrootsmarketing/gus-community-market-portal`
**Final code SHA:** `2a57353` (`2a5735355327c6dae0783b5f5c705f60b1b2f0d7`)
**Production build serving now:** `2a57353` (confirmed via public `GET /api/version`)
**Production Supabase:** `dkgjvsstbgnhcfboqqnd` · **Staging Supabase:** `tileejdviuvijumjeplv`
**Public portal:** `https://www.demohubhq.com/r/gus/`

## Status summary

CL-01 through CL-04 and CL-06 are **complete with evidence**. **CL-05 (controlled live production
smoke) is the one remaining gate** and is operator-run: it needs a live Stripe card, a controlled
test-brand email, a COI PDF, and two real Gus's slots. Until CL-05 passes, the verdict is **NO-GO for
customer invitations**; everything else in the launch envelope is verified.

This is the single evidence packet (no serial handoffs). CL-05 below is a self-contained runbook;
its evidence rows are to be filled in when the smoke is executed.

| Gate | Result |
|---|---|
| CL-01 Production Gus's tenant config | **PASS** |
| CL-02 Provisional-holds observable + OFF | **PASS** (holds set OFF + redeployed; functional re-confirm in CL-05-C) |
| CL-03 CI runs the new regression guards | **PASS** |
| CL-04 Production migration 0067 / COI atomicity | **PASS** (schema); COI behaviour re-proven in CL-05-B |
| CL-06 Final immutable release gate (automated) | **PASS** |
| CL-05 Controlled live production smoke | **PENDING — operator-run** |

---

## CL-01 — Production Gus's tenant configuration — PASS

Read-only inventory taken from prod, then two corrections applied (targeted by venue ID; no other row
touched), then re-verified on the live public portal in a fresh anonymous session.

| Venue (id prefix) | Before | After |
|---|---|---|
| Mission District `504554ce` | demo_fee **$1.00** | demo_fee **$30.00** |
| test store `0a8f6c2c` (residential West Hills addr) | active, 0 bookings, 0 demos | **deleted** (HTTP 204; no FK cascade) |
| Hayes Valley / Marina / Noe Valley / Sunset | $30, active | unchanged |

Public portal after change (fresh anon session) shows exactly five Gus's SF locations — Mission
District, Hayes Valley, Marina, Noe Valley, Sunset — **all $30 / demo**, no `test store`, no
residential address. Acceptance criteria met.

## CL-02 — Provisional-holds gate observable and OFF — PASS

- **Code:** `api/_flags.js` `flagSnapshot()` now returns effective `provisionalHolds`
  (`exactTrue(PROVISIONAL_HOLDS_ENABLED)`), surfaced only in the operator-authenticated `/api/version`
  view. Public `/api/version` remains coarse (build id + health only).
- **Offline proof:** `tests/launch_flags.test.mjs` runs `PROVISIONAL_HOLDS_ENABLED` through the full
  matrix (unset/empty/false/malformed/uppercase/padded/mixed → false; literal `true` → true).
  `tests/version_probe.test.mjs` proves the public response leaks no config footprint and the operator
  response includes `provisionalHolds`. Both green locally and in CI.
- **Production state:** the Production `PROVISIONAL_HOLDS_ENABLED` env var (Sensitive; created during
  the earlier holds-ON smoke and therefore possibly still `true`) was **explicitly set to `false` and
  the production deployment was redeployed** on `2a57353`. Holds are OFF by construction. The value is
  not dashboard-revealable (Sensitive), so the runtime re-confirmation is the CL-05-C hard-gate test
  (an unapproved brand is refused, not "held"). The full operator `/api/version` readout can be
  captured any time with `Authorization: Bearer $CRON_SECRET` — optional bonus evidence.

## CL-03 — CI runs the new regression guards — PASS

- **Finding:** `verify.yml` re-enumerated the offline suite and stopped at `admin_cancel_wiring`, so
  `admin_table_guard` and `provisional_resolution` never ran in CI despite comments saying they did.
- **Fix:** `verify.yml` now runs `- run: npm test` (single source of truth in `package.json`),
  keeping the independent migration-count and static-check steps.
- **Proof:** on `2a57353`, `verify` is green on `suites (windows-latest)` and `suites (ubuntu-latest)`;
  the logs visibly contain `admin table guard: 14 passed, 0 failed`,
  `provisional resolution: 10 passed, 0 failed`, and the CL-02 `version_probe` block, on **both** OS.
- **Negative control:** each new guard was made to fail an assertion and confirmed to exit non-zero
  (breaking the `npm test` `&&` chain → red job); reverted before commit. No `continue-on-error` or
  swallowed exit code exists on the path.

## CL-04 — Production migration 0067 / COI atomicity — PASS (schema)

Read-only production probes (`prod.env` service key; no writes):
- 5-arg `review_coi_verification(uuid,text,text,text,date)` **exists** (a call including `p_expiry`
  executed to the `verification record not found` raise).
- The obsolete 4-arg signature is **gone**: a 4-named-param call resolved to a **single** function with
  no `PGRST203` ambiguity — impossible if both overloads existed.
- `brands.default_coi_expires` and `coi_verifications.policy_expiry` both exist (select → HTTP 200).
- Execute grant is restricted to `service_role` by the `0067` DDL (revoke public/anon/authenticated +
  grant service_role in the same transaction). REST cannot read pg catalog grants directly; the atomic
  approve/refuse behaviour is re-proven functionally in CL-05-B.

`0067`'s in-migration postcondition (`P0-4: atomic COI review proven; probe rolled back`) executed on
both staging and prod at apply time.

## CL-06 — Final immutable release gate (automated) — PASS

- Local on `2a57353`: `npm run check` (68 migrations), `npm test`, `node tools/check-html-undef.mjs` —
  all green.
- **Two consecutive full staging runs from `2a57353`** (identical both runs): column checks ✓;
  route flows **182/0**; live entitlements **11/0**; live flows **21/0**; ledger fixtures **12/0**;
  adversarial payment ledger **62/0**; teardown completed.
- GitHub `verify` green on `2a57353` (windows + ubuntu). Production serves `2a57353`.
- Branch protection on `main`: required checks `suites (windows-latest)` + `suites (ubuntu-latest)`,
  `strict=false`, `enforce_admins=false` (solo push-to-deploy preserved).

---

## CL-05 — Controlled live production smoke — RUNBOOK (operator-run)

Run this on the final deployed SHA (`2a57353`). To have Claude verify alongside you, the machine needs
the repo cloned plus `demohub.env` (staging) and `prod.env` (prod) present; the interactive steps are
all browser-based.

**Operator inputs required:** a controlled test-brand email; a harmless COI PDF (no third-party PII);
two future Gus's slots to book+cancel; a real card for the Stripe screen; acceptance of live Stripe
fees. Never paste card data into chat. Pause only at the Stripe payment screen.

**Fixture discipline:** pick a run ID `launch-smoke-YYYYMMDD-HHMM`; record every created row ID; clean
up ONLY those exact IDs (never by wildcard/email-domain/date/retailer/status).

- **A. Brand identity & profile.** Magic-link sign-in as the test brand; verify session cookie is
  Secure/HttpOnly/SameSite=Lax/host-only; read profile; edit one harmless field, save, reload in a
  fresh session, prove persistence; attempt to name another `brand_id` and prove the server still
  edits only the authenticated brand. *Fill: brand_id, persistence proof, isolation result.*
- **B. COI upload, privacy, approval.** Upload the PDF; verify stored value is a private storage path
  (not a public URL); verify pending (not auto-approved); prove anon denied and cross-brand denied;
  owner gets only a short-lived link; attempt approval **without** a future expiry → refused, no
  partial change; approve **with** a future expiry → decision + reviewer + brand status + brand expiry
  + record expiry all agree. *Fill: verification_id, refusal proof, four-fact agreement.*
- **C. Hard COI booking gate (holds-OFF proof).** BEFORE approval, attempt to book → refused, with **no**
  booking/payment-group/attempt/Checkout-Session/email/demo created. AFTER approval, booking proceeds.
  *This is the functional proof that provisional holds are OFF (an uninsured brand is refused, not
  "held").* *Fill: pre-approval refusal evidence.*
- **D. Combined multi-demo live payment.** Create two future bookings; submit both IDs to one
  `/api/checkout`; verify one Checkout Session + one payment group; complete the card in Stripe; wait
  for signed webhooks (no manual patching); verify exactly one PaymentIntent/charge, one paid group,
  one paid attempt, two immutable allocations summing to the charge, both bookings paid, two
  fulfillment rows, two demos, expected emails once each, webhook replay is idempotent, no
  reconciliation case. *Fill: charge/PI/session/group/attempt/booking/allocation IDs (truncated),
  fulfillment counts.*
- **E. Single-demo refund isolation.** Cancel/refund only booking A via `booking-action.js`; wait for
  the signed refund convergence; verify only allocation A refunded, booking A refunded/cancelled only
  after verified Stripe success, demo A cancelled, booking B + allocation B + demo B untouched, Stripe
  shows only the partial refund, replay creates no second refund. Then clean up booking B via the same
  path. *Fill: per-booking refund isolation evidence.*
- **F. Cleanup & reconciliation.** Reconcile Stripe vs ledger; resolve any mismatch; deactivate/remove
  only the run-ID fixtures; confirm the public portal shows no smoke fixture.

**Immediate NO-GO if any:** unapproved brand can book/reach Stripe; holds active; wrong or multiple
charges; paid webhook doesn't fulfill both exactly once; payment succeeds but a booking/demo missing;
one refund changes another allocation/booking/demo; refund terminalizes before Stripe verifies; COI
public or cross-brand readable; COI decision/expiry disagree; any binding mismatch; any unresolved
reconciliation case.

---

## Final verdict

**NO-GO for customer invitations — pending CL-05 only.** CL-01, CL-02, CL-03, CL-04, and CL-06 pass on
the final deployed SHA `2a57353`: provisional holds are OFF (set + redeployed), verified COI is
required before booking, connected checkout is hard-disabled, production venues/prices are corrected,
CI runs the security guards on both OS, migration 0067 is applied to prod, and two consecutive full
staging runs are green.

On a clean CL-05 pass (all of A–F, no NO-GO condition), this becomes
**GO — CLOSED GUS'S LAUNCH, HOLDS OFF**: provisional holds OFF; verified COI required before booking;
live immediate-capture payments pass; brand profiles pass; COI upload/privacy/manual-review/expiry
pass; combined multi-demo payment passes; single-demo refund isolation passes; connected checkout
disabled; production fixtures/prices verified; no unresolved reconciliation case.
