# Demohub — Final Launch Remediation: Consolidated Closure Packet (Round 2)

**Responds to:** Codex "Independent Review of closurepacketfinallaunch.md" (2026-09-03) and its mandatory fix order (Tasks 0–7, findings F-01…F-10).
**Supersedes:** the 2026-09-03 packet (RC `4592ed3`, GO), whose capacity/payment gate Codex correctly downgraded.
**Prepared:** 2026-09-04 · **Branch:** `fix/codex-round2`
**Recommendation:** **GO — CLOSED GUS PILOT** (§12)

---

## 1. Release identity

| Item | Value |
|---|---|
| Baseline at Task 0 | `origin/main` = local `main` = `84f4551c8271d6bc88b5e49d60a7c4801d36b175`, tree clean; prod `/api/version` build `84f4551`, status `operational`; migrations 0000–0069 (70 files) |
| Final commit SHA (RC) | **`fdc87df5f628628cc5793d24b7001f7b9c8d044b`** |
| Branch | `fix/codex-round2` → `main` fast-forwarded `84f4551 → fdc87df` and pushed 2026-09-04 08:22Z. `origin/main` = production build = `fdc87df`; this packet lives on `docs/closure-round2` so `main` stays byte-identical to production. |
| Commits on top of `84f4551` | `ef5e177` round-2 fixes · `4253585` S1 test choreography · `1d08033` Stripe test-mode e2e + evidence · `5ffc140` cron_heartbeats self-seeds ledger fixtures · `85ec2b1` CI passes STAGING_DB_URL to the staging gate · `fdc87df` S1/S2 wait-state diagnostics poll instead of single sample |
| Working tree at RC | clean (`git status --porcelain` → 0) |
| Test database | Supabase project **demohub-rebuild-check** (`tileejdviuvijumjeplv`), migrations 0000–0071 applied |
| Production database | Supabase project **demohub-prod** (`dkgjvsstbgnhcfboqqnd`), migrations 0000–0071 applied (0070 + 0071 via SQL editor 2026-09-04 ~08:15Z, verified §10) |
| Production build after deploy | **`fdc87df`** — `/api/version` 2026-09-04T08:23:37Z (first) and 08:24:08Z |
| Environment bindings | `api/_binding.js` target check: preview/test binds only `tileejdviuvijumjeplv`; production binds `dkgjvsstbgnhcfboqqnd`; CI positive allowlist `STAGING_REF_EXPECTED=tileejdviuvijumjeplv`, deny `PRODUCTION_REF_DENIED=dkgjvsstbgnhcfboqqnd` |

Containment held throughout: public retailer signup OFF (403), provisional holds OFF, Gus venues cap 1, no viewer accounts, no second retailer, no pricing change, no payment-grouping redesign, no Supabase rebuild.

## 2. Root cause and exact files/lines (F-01 … F-09)

| Finding | Root cause | Fix (file:line) |
|---|---|---|
| **F-01** capacity decrease not serialized against inserts | `enforce_slot_capacity()` / `_on_move()` (0066) read `max_demos_per_slot` into a local **before** taking the per-slot advisory lock; a waiting insert kept a stale cap, and 0069's guard locked only slots that already had bookings (an empty slot took no lock). | `supabase/migrations/0070_capacity_serialization.sql`: both triggers `SELECT max_demos_per_slot … FOR SHARE` on the venue row first, then the identical advisory lock, then the identical canonical count. A cap UPDATE needs the row's exclusive lock, so it waits for every in-flight insert and re-counts (0069), and later inserts wait for the decrease and read the new cap. Move trigger now also fires `BEFORE UPDATE OF … status` and rechecks when an excluded status is **reactivated** (counting `id <> NEW.id`). `CHECK (max_demos_per_slot >= 1)` (`venues_max_demos_per_slot_min`), column stays NOT NULL. Post-condition DO block asserts all of it. |
| **F-02** cross-retailer compliance relationship injection | `CLIENT_WRITABLE_FIELDS` had no `compliance_records` entry; the single-column FK proved only existence; `fetchComplianceCoi()` read compliance records globally by email; the daily warning looked up contacts by id only. | `supabase/migrations/0071_compliance_tenant_integrity.sql`: `UNIQUE brand_contacts(id, retailer_id)`; composite FK `compliance_records(brand_contact_id, retailer_id) → brand_contacts(id, retailer_id)` (NOT VALID → VALIDATE; anomalies would abort, none existed); old FK `compliance_records_brand_contact_id_fkey` dropped (avoids PGRST201 embed ambiguity); `compliance_tenant_anomalies()` audit (service_role). `api/admin.js:95` allowlist; `:510` uniform 400 `invalid_brand_contact_id`; `:518` uniform 404 `not_found` when the contact is not the session retailer's (foreign and nonexistent indistinguishable); `:525` `file_url` http(s)-only; warn-cursor fields server-owned. `api/coi-enforcement.js:123` `fetchComplianceCoi(brandEmail, retailerId)` filters `retailer_id=eq.<booking.retailer_id>`, caller `:202`. `api/brand-account.js:1804` daily lookup requires both id and `rec.retailer_id`. |
| **F-03** workers report `succeeded` with per-item failures | Per-item errors incremented `out.errors` then an unconditional `succeeded` heartbeat; status treated a later `failed` as healthy. | `api/refund-worker.js:275` `runOk = out.errors === 0 && !fulfilmentFailed && !alertsFailed` (claim failures surfaced by `api/_fulfillment.js`); `api/provisional-sweep.js:112` `out.errors === 0`; `api/brand-account.js:1964` daily `cronOk = errors.length === 0`; all write `failed` (+`summary.partial`, redacted `first_error`) and return **500** otherwise. `api/find-retailer.js:39–49` health = latest **completed** row is `succeeded` AND fresh (35 min / 25 h); `started` rows ignored; public payload still `{ok, required}`. |
| **F-04** prod SHA ≠ fully gated SHA | Two presentation-only commits after the gated run. | This packet freezes **one** SHA `fdc87df`, runs the full manual gate on it (§9), deploys exactly it (§10). No commit after validation. |
| **F-05** refund proof had no sibling | Only one prod booking existed; ledger tests used synthetic Stripe ids. | Real Stripe **test-mode** grouped two-demo journey (§8): one PaymentIntent for two children, partial refund of A only, sibling B intact, replays idempotent, B refunded, over-refund refused everywhere. |
| **F-06** support-access toggle not enforced | `owner-impersonate` ignored `allow_support_access` / `support_access_expires_at`; audit insert best-effort. | `api/admin-auth.js:91` `supportAccessExpiryMs()` (null unless `allow_support_access === true` and expiry parses to the future); `:101` `impersonationWindow()` = min(4 h, consent expiry) for both DB `expires_at` and cookie Max-Age; `:1411` 403 `support_access_disabled` (same body for OFF/missing/invalid/expired); `:1447` fail-closed audit: `support_sessions` insert failure deletes the new `admin_sessions` row → 500 `audit_unavailable`, no cookie. UI copy (`r/gus/admin/index.html` ~6463) already matched. |
| **F-07** status page reads removed fields | Page consumed `db.ms`, `cron.hours_since/outcome`, `errors.last_24h`. | `status/index.html:211` `renderStatusModel()` (pure; only `checks.db.ok`, `checks.cron.ok`, `checks.cron.jobs[*].{ok,required}`, `checks.errors.ok`, incidents, `checked_at`) and `:273` `renderStatusRows()` (createElement/textContent only). `required:false` renders neutral, never red. |
| **F-08** UI offered "0 = No limit" (null) | Column NOT NULL; triggers treat NULL cap as "not your venue". | `r/gus/admin/index.html:3376` `parseCapacityInput()` — whole number ≥ 1 only; editor `<input type=number min=1 step=1>`, single-venue save, apply-to-all, CSV import (per-row rejection, import disabled) all reject 0/negative/blank/decimal with a visible message; never sends null. |
| **F-09** stale CI deny ref | `PRODUCTION_REF_DENIED` named the retired project. | `.github/workflows/verify.yml:81` → `dkgjvsstbgnhcfboqqnd`; `:90` `EXPECTED_MIGRATIONS: '72'`. Positive `STAGING_REF_EXPECTED` remains primary. |
| F-10 (acknowledged) | CSP `unsafe-inline`/`unsafe-eval`; ESLint-chain audit advisories. | Unchanged; tracked in §11. |

## 3. Migrations added and clean application

- `0070_capacity_serialization.sql` and `0071_compliance_tenant_integrity.sql` (forward-only; 0066/0069 untouched). Total 72 files.
- Applied to demohub-rebuild-check via SQL editor 2026-09-04 (both "Success"); verified over a direct Postgres connection: `enforce_slot_capacity` source contains `FOR SHARE`; `compliance_tenant_anomalies()` exists and returns 0 rows.
- Clean apply from zero, twice: CI job **clean build A/B (staging)** success on `fdc87df` (run 33848469130; 0000→0071 applied to a reset demohub-rebuild-check twice, manifest count 72).
- Production apply: 0070 then 0071 in demohub-prod SQL editor (both "Success. No rows returned"); verified: `compliance_tenant_anomalies()` → 200 `[]`; CHECK probe `PATCH venues Sunset max_demos_per_slot=0` → 400 `23514 venues_max_demos_per_slot_min`, row unchanged at 1; `capacity_invariant_violations(p_future_only:=false)` → `[]`.

## 4. Deterministic capacity transcript (`tests/capacity_serialization.test.mjs`, direct `pg` connections, demohub-rebuild-check, RC tree)

```
— PREFLIGHT: migration 0070 is applied —
  ok   0070 applied: FOR SHARE in both booking triggers, reactivation re-check, move trigger fires on status, CHECK validated
  ok   S1: both inserts are parked on the slot advisory lock (FOR SHARE already taken)
  ok   S1: the cap decrease does NOT complete while inserts hold FOR SHARE on the venue row (blocked >= 1500ms)
  ok   S1: pg_stat_activity shows the decrease waiting on a Lock
  ok   S1: first insert to win the slot lock succeeds under cap 2 (the cap it read under FOR SHARE is still 2)
  ok   S1: decrease is STILL blocked while both insert transactions are open
  ok   S1: second insert then succeeds under cap 2 (count 1 < cap 2; still the pre-decrease cap)
  ok   S1: decrease is STILL blocked while the second insert is open (its FOR SHARE alone holds it)
  ok   S1: once the inserts commit, the decrease FAILS with capacity_below_active_reservations
  ok   S1: final state is cap 2 / active 2 — never cap 1 / active 2
  ok   S1: capacity_invariant_violations() returns zero rows
  ok   S2: the insert does NOT complete while the decrease holds the venue row (blocked >= 1000ms)
  ok   S2: pg_stat_activity shows the insert waiting on a Lock (FOR SHARE vs the UPDATE)
  ok   S2: after the decrease commits, the waiting insert is admitted (reads cap 1, count 0)
  ok   S2: a second insert is refused with slot_full under the new cap
  ok   S2: final state is cap 1 / active 1
  ok   S3: cancelled -> pending on a full slot is refused with slot_full
  ok   S3: cancelled -> confirmed on a full slot is refused with slot_full
  ok   S3: reactivation succeeds once the slot has room; reviving the other booking is then refused
— SCENARIO 4 (stress): 100 x { 3 concurrent inserts + 1 concurrent decrease } —
  stress: 100 runs, 0 violations
  ok   S4: active_count <= cap after every run (100 runs); invariant empty after every run; no deadlocks; every failure is a 23514 business refusal
  ok   S5: cap 0 refused (23514 venues_max_demos_per_slot_min); negative refused; NULL refused (23502); insert with cap 0 refused
  ok   teardown: bookings / 104 fixture venues / 5 fixture retailers all gone
capacity serialization: 38 passed, 0 failed
```

Note on the first run (32/36): the four S1 failures were test choreography (the harness awaited both insert statements while the first still held the transaction-scoped slot lock, and Postgres may grant a released advisory lock to either waiter). Fixed in `4253585` (commit whichever insert wins first); the database behavior was already correct in every scenario. `tests/capacity_guard.test.mjs` (REST) 35/35 incl. new S7 (cancelled → pending into a full slot refused).

## 5. Compliance cross-tenant matrix (`tests/compliance_tenant.test.mjs`, 35/35)

| Case | Result |
|---|---|
| Retailer A POST compliance record with Retailer B's contact id | 404 `not_found` |
| Retailer A POST with a nonexistent contact id | 404 `not_found` — **identical** status and body |
| Malformed contact ids (several shapes) | 400 `invalid_brand_contact_id`, identical for all; never reaches Postgres |
| Retailer A POST with own contact | 201, pinned to A, linked to A's contact |
| Client-supplied `coi_warn_30_sent_at`, `created_at`, `id` | ignored (server-owned) |
| A PATCH own record → B's contact | 404; row unchanged |
| A PATCH `retailer_id` → B | pinned to A; `expires_at` change resets warn cursors |
| Direct service-role INSERT/UPDATE of (contact B, retailer A) | FK violation 23503 (DB constraint) |
| `compliance_tenant_anomalies()` | 0 rows |
| Unlinked record (`brand_contact_id` null) | accepted (MATCH SIMPLE) |
| `file_url` `javascript:` / `data:` / attribute-breakout | 400 `invalid_file_url`; https accepted; '' → null |
| Enforcement (real cron route, dry_run): Retailer A record with matching brand email vs a **Retailer B** booking | B booking coverage `missing` (A's record not considered); A booking covered; zero Stripe/Resend calls; B row untouched |

## 6. Worker partial-failure and status recovery (`tests/cron_heartbeats.test.mjs`, 67/67 + holds-on child 20/20)

- Stripe refund POST fault **after** claim → HTTP 500, heartbeat `failed`, `refund-worker.ok:false`, `cron.ok:false`, status not operational.
- One bad item among two → `errors:1, resubmitted:1`, `failed`; DB shows one `succeeded` + one `failed_retryable`.
- Fulfillment-drain claim fault → `failed`.
- Clean run → `succeeded`, `ok:true` (recovery).
- Fixture `failed` after a fresh `succeeded` → `ok:false`; later `succeeded` recovers. Daily `started` rows ignored; daily `failed` flips.
- Sweep per-booking PATCH fault (holds ON) → 500, `failed`, booking stays held, sweep `ok:false`; clean run expires it and recovers.
- Unauthenticated cron → 401, no heartbeat. Public payload = exactly `{ok, required}` per job (regex-enforced).

## 7. Support-access evidence (`tests/support_access.test.mjs`, 61/61)

OFF → 403 `support_access_disabled`, no `admin_sessions` row, no cookie · expired consent → 403 same body · `allow=true` with null expiry → 403 same body · valid ON (2 h) → 200, cookie, `expires_at ≈ 2 h` (min rule) · consent 10 h → `≈ 4 h` · injected `support_sessions` POST 503 → 500 `audit_unavailable`, no cookie, new `admin_sessions` row deleted · unknown retailer → unchanged refusal · end-impersonation still works. `tests/session_transport.test.mjs` 76/76 (its stub retailer now correctly gets 403).

## 8. Stripe test-mode grouped two-demo partial-refund evidence (`tests/stripe_testmode_grouped.e2e.mjs`, **84 passed, 0 failed**, 2026-09-04)

Evidence file: `tests/evidence/stripe-testmode-grouped-2026-09-04.md` (+ `-checkout-form.png`, `-checkout-paid.png`). Real Stripe **test mode** (`sk_test_` asserted), shipped routes in-process, Resend intercepted, real events re-signed into the real webhook verifier (wrong secret → 400, unsigned → 400).

| Step | Evidence |
|---|---|
| Two demos, one checkout | venue A $7 + venue B $9; `POST /api/checkout {booking_ids:[A,B]}` → **one** `cs_test_b1aByg97…`; one route Stripe call |
| One PaymentIntent covers both | `pi_3UBq1gJ9aYEf28il1XCcyy4g`, charge `ch_3UBq1gJ9aYEf28il1AzafrCs`; allocations 700 + 900 = group total **1600** = session `amount_total` = PI `amount_received` |
| Hosted checkout completed | Playwright + Stripe published test card; ground truth `payment_status=paid` via Stripe API; screenshot |
| Webhooks | real `checkout.session.completed` (`evt_1UBq1iJ9…`) + `payment_intent.succeeded` (`evt_3UBq1gJ9…axZNsqp`) applied; re-post → `duplicate:true`, ledger byte-identical |
| Both confirmed via app flow | `booking-action confirm` ×2 → `confirmed`, one demo each |
| Refund child A only | `booking-action cancel` (exact admin payload) → exactly one `POST /v1/refunds` → **`re_3UBq1gJ9aYEf28il1lDSrcea` = 700**; A `cancelled/refunded`, **B `confirmed/paid`**, group `partially_refunded`, alloc A `refunded 700 / reserved 0`, alloc B `0/0`; real `refund.created` + `charge.refunded` replayed |
| Replay | cancel A again → 409; webhooks re-posted → `already_terminal`/`duplicate`; refund-worker run → `claimed 0`; Stripe still exactly 1 refund; zero further Stripe writes |
| Refund child B | `re_3UBq1gJ9aYEf28il1D1fj1or` = 900; Stripe refunds total **1600 = capture**; charge `refunded=true, amount_refunded=1600`; group `refunded`; both allocations fully refunded; two `refund_requests` `succeeded`, each bound to its own `re_` |
| Over-refund refused | cancel B again → 409; decline A → 409 (no Stripe call); direct `refund_reserve_cas` → `nothing_refundable`; direct 1-cent `POST /v1/refunds` → Stripe `charge_already_refunded`; 0 `reconciliation_cases` |

## 9. GitHub Actions — final SHA `85ec2b1`

Run: https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/33848469130 (`workflow_dispatch`, `clean_build=true`, `staging_gate=true`)

| Job group | Result |
|---|---|
| suites (ubuntu-latest) | ✅ success |
| suites (windows-latest) | ✅ success |
| clean build A/B (staging) | ✅ success (1m 10s) |
| staging gate (pass 1) | ✅ success (5m 41s) |
| staging gate (pass 2, consecutive, same commit) | ✅ success (5m 34s) |

Both passes, identical totals: route flows 182 · cron heartbeats 67 (+20 holds-on child) · isolation matrix 45 · compliance tenant integrity 35 · support access 61 · live entitlements 11 · live flows 21 · ledger fixtures 12 · payment ledger adversarial 62 · provisional holds adversarial 28 · capacity guard 35 · **capacity serialization 38 (stress: 100 runs, 0 violations)** — all 0 failed. Staging environment approvals by `grassrootsmarketing`.

Superseded runs on this branch (not evidence): 33842184655 (`1d08033`, cron_heartbeats depended on `test:ledger` fixtures a clean database lacks), 33843388823 (`5ffc140`, `SB_DB_URL` not yet provided to CI), 33845711544 (`85ec2b1`, one single-sample `pg_stat_activity` diagnostic raced in pass 2). Each fix touched test/CI plumbing only; no application code changed after `ef5e177`.

Local on the same tree: `npm run check` ✓ (72 migrations; 46 api modules; no-undef 85 files; binding), `npm run check:columns` ✓✓, `npm test` 17/17 suites, `test:routes` (route flows 182, cron heartbeats 67+20, isolation 45, compliance tenant 35, support access 61), `test:capacity` (35 + 38), `test:live` 11+21, `test:ledger` 12/62/28 (prior RC tree; rerun in CI).

## 10. Production (2026-09-04, build `fdc87df`)

| Check | Result |
|---|---|
| Deploy exact SHA | `main` pushed `84f4551..fdc87df`; `/api/version` → `{"build":"fdc87df"}` at 08:23:37Z and 08:24:08Z |
| Environment bindings | reads below hit `dkgjvsstbgnhcfboqqnd`; status route reports the prod heartbeat table; CI deny list names this ref |
| Migrations | 0070 + 0071 applied and verified (§3) |
| Containment | `POST /api/retailer-signup` → **403**; holds OFF (`provisional-sweep required:false`); venues all cap **1** (10 venues); `retailer_admins role=viewer` → **0**; active holds → **0**; retailers: `gus`, `__owner__`, `harvest-lane-demo` only (no second live retailer) |
| Anonymous probes | `/api/admin?action=data` 401 · `/api/brand-account?action=data` 401 · `/api/refund-worker` 401 · `/api/provisional-sweep` 401 |
| Capacity invariant | `capacity_invariant_violations()` → `[]` (future and full history) |
| Compliance tenant invariant | `compliance_tenant_anomalies()` → `[]` |
| Support access (Gus) | `allow_support_access=false`, `support_access_expires_at=null` → impersonation is 403 by construction (F-06) |
| Booking / payment ledger unchanged since the 2026-09-03 live proof | 1 booking `8ee26656…` `cancelled/refunded` 100¢ `re_3UBWJyPSiN5YlLGb000Lccqo`; 1 payment group `8945cad8…` `refunded` 100; 1 refund request `succeeded` 100 |
| Cron | scheduled heartbeats every 15 min on the new build: refund-worker `succeeded` 07:45:58, 08:00:56, 08:15:57Z; provisional-sweep `succeeded` 07:45:22, 08:01:13, 08:15:22Z; public status `operational`, `cron.ok:true`, all three jobs `ok:true` |
| Status page (F-07) | https://www.demohubhq.com/status renders: Database Operational · Scheduled jobs Healthy · Refund processing Running · Daily tasks Running · Provisional holds sweep "Off in this environment / Not required" · API error rate Normal; no undefined/never/NaN text |

No live-money transaction was repeated in this round: the 2026-09-03 live $1 capture/refund remains the production money proof (rows unchanged above), and the grouped partial-refund shape Codex required is proven against real Stripe **test mode** (§8), as the order specified.

## 11. Non-blocking follow-ups

| Item | Owner | Deadline |
|---|---|---|
| CSP `unsafe-inline`/`unsafe-eval` → nonce/hash conversion (no working XSS found) | Claude | hardening project, pre-public launch |
| ESLint-chain audit advisories (dev only) | Claude | dependency maintenance |
| `api/venues-bulk-import.js:202` server still coerces invalid capacity to 1 (UI now rejects; CHECK enforces ≥1) — make the server reject like the UI | Claude | next release |
| Yahoo/AOL deliverability (Yahoo Sender Hub) | David | before public launch |
| Delete retired Supabase project "Demohub" (`ecapm…`) after backup | David | post-pilot |
| Test brand `Launch Proof Foods` + refunded $1 booking in prod (audit trail) | David | keep or scrub |

## 12. Gates and recommendation

| Gate | Result | Evidence |
|---|---|---|
| F-01 capacity serialization | **PASS** | §4 (38/38 locally and in both CI passes; 100-run stress, 0 violations); §3/§10 prod CHECK + invariant |
| F-02 compliance tenant integrity | **PASS** | §5 (35/35 both passes); prod anomalies `[]`; DB constraint live |
| F-03 worker health accuracy | **PASS** | §6 (67+20 both passes); prod status operational under the latest-outcome rule |
| F-04 one immutable SHA | **PASS** | `fdc87df`: full gate run 33848469130 green; `origin/main` = production build |
| F-05 grouped partial refund proven | **PASS** | §8 real Stripe test-mode journey 84/84, sibling intact, replay and over-refund refused |
| F-06 support-access consent | **PASS** | §7 (61/61 both passes); Gus consent OFF in prod |
| F-07 status page | **PASS** | §10 status-page row; `tests/status_page.test.mjs` 43/43 |
| F-08 capacity input ≥ 1 | **PASS** | `tests/capacity_input.test.mjs` 75/75; DB CHECK enforces server-side |
| F-09 CI guard | **PASS** | `verify.yml:81` = `dkgjvsstbgnhcfboqqnd`; `EXPECTED_MIGRATIONS` 72 asserted by the green run |
| Closed-Gus containment | **PASS** | §10 containment row |

**GO — CLOSED GUS PILOT**

Gus remains the only retailer; capacities stay at 1; provisional holds and public retailer signup stay OFF; no viewer accounts. General / multi-retailer launch remains NO-GO until the §11 items are scheduled and a public-launch order is issued.
