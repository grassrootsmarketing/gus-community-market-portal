# Demohub — Final Launch Remediation: Consolidated Closure Packet

**Work order:** Codex "Final Launch Remediation Work Order for Claude Code" (starting prod build `bfba11e`)
**Prepared:** 2026-09-03 · **Branch:** `remediation/final-launch` → merged fast-forward into `main`
**Recommendation:** **GO — CLOSED GUS PILOT** (see §13)

---

## 1. Release identity

| Item | Value |
|---|---|
| Final commit SHA (RC, deployed) | `4592ed33a74b64331984b9aa44f7ac827f6c91d3` |
| Branch | `remediation/final-launch` (pushed); `main` fast-forwarded `bfba11e → 4592ed3` and pushed 2026-09-03 ~08:30Z |
| Starting `origin/main` | `bfba11ea9e55d6a758d38bb813571378e85d4e6b` |
| Production build before | `bfba11e` (`/api/version` 2026-09-03T07:22Z) |
| Production build after | **`4592ed3`** (`/api/version` 2026-09-03T08:32:27Z; re-read 08:53:29Z) |
| Staging DB | `tileejdviuvijumjeplv` — migrations 0000–0069 (0068 + 0069 applied 2026-09-03 via SQL editor) |
| Production DB | `dkgjvsstbgnhcfboqqnd` — migrations 0000–0069 (0069 applied 2026-09-03 ~08:20Z via SQL editor; verified by `capacity_invariant_violations()` 200) |
| Working tree at RC | clean (`git status --porcelain` → 0 lines) |
| Retired project | `ecapmcyumpjjgjwuokyv` ("Demohub") — not used by any binding |

Commits on top of `bfba11e`:
- `2da0089` — Final-launch remediation: close COI oracle, enforce viewer scope, guard capacity decreases, per-job cron heartbeats
- `4592ed3` — ci: EXPECTED_MIGRATIONS 69 → 70 for 0069 (workflow count assertion only; no application code)

## 2. Diff summary and migrations added

```
 .github/workflows/verify.yml                         |   3 +-
 api/admin-auth.js                                    |   6 +-
 api/admin.js                                         |  75 +++++--
 api/find-retailer.js                                 |  69 +++++-
 api/provisional-sweep.js                             |  20 ++
 api/refund-worker.js                                 |  21 ++
 package.json                                         |   5 +-
 supabase/migrations/0069_capacity_decrease_guard.sql | 107 +++++++++  (NEW)
 tests/capacity_guard.test.mjs                        | 216 ++++++  (NEW)
 tests/cron_heartbeats.test.mjs                       | 238 ++++++  (NEW)
 tests/isolation_matrix.test.mjs                      | 243 ++++++  (NEW)
 11 files changed, 970 insertions(+), 33 deletions(-)
```

Migrations added: **0069_capacity_decrease_guard.sql** only. No already-applied migration was edited; history remains forward-only (0000…0069). Applied from zero in CI clean build A/B (§7).

## 3. Root cause, implementation, files/lines

### Phase B — Cross-retailer COI oracle (`api/admin.js`)
- **Root cause.** The table proxy let a retailer write `brand_id` on `brand_contacts` (a relationship field), and `action=data` enriched every brand contact with the brand's `coi_status`/`coi_expires` by matching on planted `brand_id` **or** email. A retailer could plant any brand's UUID or email and read that brand's COI state with no relationship: an existence + status oracle across tenants.
- **Fix.** `brand_id` added to `SERVER_OWNED_FIELDS` (line 72) and stripped on every write (line 501); per-table `CLIENT_WRITABLE_FIELDS` allowlists (line 85, enforced line 509) drop unknown columns; enrichment restricted to brands with a booking **at this retailer** (`provenBrandIds`, lines 321–322). The email fallback is gone.
- **Old vs new** (same test file, staging): pre-fix **13 failures** (planted `brand_id` persisted; stranger brand returned `coi_status: approved`; viewer received full payload); post-fix **45/45**.

### Phase C — Viewer scope enforced on the server (`api/admin.js`, `api/admin-auth.js`)
- **Root cause.** Viewer scoping was a client-side filter. `action=data` returned the retailer's full payload (all venues/bookings, brand contacts with PII, staff roster, compliance records incl. document numbers, `cal_feed_key`, billing fields) to any viewer; `team-list` and `agreement-retailer-list` answered 200 to viewers.
- **Fix.** `callerIsViewer` (line 274) + `viewerVenueIds`; viewer branch of `action=data` (line 337) returns only scoped venues/demos/bookings via field pickers, empty `brand_contacts` / `internal_contacts` / `compliance`, settings limited to `demo_duration` / `advance_booking_days`. `admin-auth.js` lines 487 and 494: both list actions require role in owner/admin/manager → 403 for viewers. Admin UI already tolerates the 403 (calls are wrapped in try/catch).

### Phase D — Capacity decrease guard (`supabase/migrations/0069_capacity_decrease_guard.sql`)
- **Root cause.** `venues.max_demos_per_slot` could be lowered below the number of active reservations already on a future slot (0047/0066 only guard inserts/moves), leaving over-capacity slots that could capture concurrently.
- **Fix.** `guard_capacity_decrease()` BEFORE UPDATE OF `max_demos_per_slot`: on a decrease, for every future slot with active bookings take the **same** per-slot advisory lock (`hashtextextended(venue|date|time, 0)`) and the **same** active predicate (status not in cancelled/declined/expired/auth_canceled) as 0047/0066, re-count under the lock, raise `check_violation` if count > new cap (UPDATE aborted). Past slots deliberately excluded. `capacity_invariant_violations(p_venue_id, p_future_only)` read-only audit, `service_role` only.

### Phase E — Per-job cron observability (`api/refund-worker.js`, `api/provisional-sweep.js`, `api/find-retailer.js`)
- **Root cause (code).** Only the daily job wrote heartbeats and the status route read the single most-recent row of *any* job (< 25 h = healthy), so a dead 15-minute refund worker was masked.
- **Root cause (operations, discovered during this order).** **Vercel Cron Jobs were disabled at the project level in production** (toggle "Disabled"). `cron_heartbeat` was empty since project creation and public status already read `degraded`. **Enabled by David 2026-09-03 ~08:20Z.**
- **Fix.** `heartbeat()` in refund-worker (line 52) and provisional-sweep (line 42) writes `succeeded` / `failed` rows per run (failure path included). `CRON_JOBS` (find-retailer line 19) + `cronJobHealth()` (line 27) judge each job by its own latest `succeeded` row: `refund-worker` < 35 min (always required), `provisional-sweep` < 35 min (required only while `FLAGS.provisionalHolds`), `daily` < 25 h. Unreadable heartbeat table ⇒ required jobs unhealthy. Public payload exposes only `{ok, required}` per job (DH-21).

## 4. Automated tests — names and unedited totals (RC tree, staging DB `tileejdviuvijumjeplv`, 2026-09-03)

| Suite | Command | Result |
|---|---|---|
| Static/project check | `npm run check` | migrations ✓ · 46 api modules import (0 network) · no-undef 79 files ✓ · binding ✓ |
| Offline unit suite | `npm test` | all suites 0 failed (incl. admin table guard 14/14, provisional resolution 10/10) |
| Column/schema contract (staging binding) | `npm run check:columns` | ✓ migration-chain columns · ✓ JS-referenced columns |
| Isolation matrix (Phase B+C) | `node tests/isolation_matrix.test.mjs` | **45 passed, 0 failed** (pre-fix code: 32 passed, **13 failed**) |
| Cron heartbeats (Phase E) | `node tests/cron_heartbeats.test.mjs` | **41 passed, 0 failed** (incl. holds-ON child 9/9) |
| Capacity guard (Phase D) | `node tests/capacity_guard.test.mjs` | **32 passed, 0 failed** |
| Route flows | `node tests/route_flows.test.mjs` | **182 passed, 0 failed** |
| Live entitlements / live flows | `npm run test:live` | **11/11**, **21/21** |
| Ledger fixtures / payment ledger adversarial / provisional holds adversarial | `npm run test:ledger` (with `LEDGER_TARGET_REF`, `ALLOW_STAGING_LEDGER_TESTS=yes`) | **12/12**, **62/62**, **28/28** |

The same totals were reproduced by CI staging pass 1 and pass 2 on `4592ed3` (§8).

**Production-dependency audit** (`npm audit`, final lockfile): 2 high — `brace-expansion@1.1.17` (path: eslint → minimatch) and `js-yaml@4.3.0` (path: eslint → @eslint/eslintrc). Both reachable **only** through `eslint`, a devDependency. `npm ls --omit=dev --all` = `pg@8.22.0` + transitive deps, **0 findings**. Classification: development tooling, not production runtime.

## 5. Authorization matrix (HTTP response level, `tests/isolation_matrix.test.mjs`)

Fixtures: Retailer A (venues A1, A2; owner; viewer-A1 scoped to A1; viewer-A2 scoped to A2), Retailer B (venue B1; owner). Brands: brandA (booked at A1, held), brandB (probe target, no relationship), brandX (stranger).

| Actor → target | Result |
|---|---|
| Owner A POST brand_contact with foreign `brand_id` | 2xx, stored row has **no** `brand_id`, pinned to A |
| Owner A PATCH `retailer_id` / `brand_id` on own row | ignored; allowed field applied |
| Owner A POST with foreign `retailer_id` | 403 |
| Owner A `action=data`: contacts planted with brandB email (exact/upper/spaces/alias/dup/nonexistent) | **no** `coi_status` / `coi_expires` on any; key set identical to nonexistent-email probe |
| Owner A: brand that booked at A (held) | enriched (relationship server-proven) |
| Owner A: stranger brandX contact | not enriched |
| Viewer A1 `action=data` | 200; venues = {A1}; bookings only A1; brand_contacts / internal_contacts / compliance empty; no doc identifiers, `cal_feed_key`, billing, or contact PII; settings minimal |
| Viewer A2 `action=data` | venues = {A2}; no A1 booking |
| Viewer `team-list` / `agreement-retailer-list` | **403**, no roster / no brand emails |
| Viewer PATCH by guessed id | 403 |
| Owner A PATCH/DELETE Retailer-B row by guessed id | 403, row untouched |
| Owner A / Owner B full reads | own venues + collections intact; nothing of the other |

## 6. Capacity & payment concurrency

- Two parallel inserts at cap 1 → exactly one succeeds, loser `slot_full`, DB holds one reservation (S5).
- Cap 2 with two active future holds → PATCH `max_demos_per_slot=1` refused with `capacity_below_active_reservations` (errcode 23514), cap remains 2; 2→2 and 2→5 succeed (S1). Cap 3 with 2 active → 2 OK, → 1 refused (S2). No bookings / past-only → decrease allowed (S3). Cancelled/expired/declined don't count (S4). Cap-1 slot with 1 hold → 0 refused (S5).
- Multi-demo grouped payment, partial cancel/refund without sibling fan-out, webhook replay idempotency: payment ledger adversarial 62/62; provisional holds adversarial 28/28 (on RC tree, and again in CI pass 1 and 2).
- **Invariant query output** — `select * from capacity_invariant_violations();`
  - staging (after full suite + teardown): `[]`
  - production (after 0069 apply, future scope): `[]`
  - production (`p_future_only := false`, full history): `[]`

## 7. GitHub Actions (final SHA)

**Run:** https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/33727695098 — `verify` #112, `workflow_dispatch` on `4592ed3` with `clean_build=true`, `staging_gate=true`. Status **Success**, total 41m 13s. Staging environment approval by `grassrootsmarketing`.

| Job group | Result |
|---|---|
| suites (ubuntu-latest) | ✅ success |
| suites (windows-latest) | ✅ success |
| clean build A/B (staging) | ✅ success (2m 35s) — fresh apply 0000→0069 twice |
| staging gate (pass 1) | ✅ success (3m 23s) |
| staging gate (pass 2, consecutive, same commit) | ✅ success (3m 10s) |

Run 33727513592 on `2da0089` failed the migration-count assertion (70 files vs `EXPECTED_MIGRATIONS: 69`) and is **not** evidence; superseded by the RC.

## 8. Staging adversarial passes (from the CI staging-gate job logs, same commit, consecutive)

| Suite | Pass 1 | Pass 2 |
|---|---|---|
| isolation matrix (Phase B + C) | 45 passed, 0 failed | 45 passed, 0 failed |
| cron heartbeats (+ holds ON child) | 41 (+9) passed, 0 failed | 41 (+9) passed, 0 failed |
| capacity guard | 32 passed, 0 failed | 32 passed, 0 failed |
| route flows | 182 passed, 0 failed | 182 passed, 0 failed |
| live entitlements / live flows | 11 / 21 passed, 0 failed | 11 / 21 passed, 0 failed |
| ledger fixtures / payment ledger adversarial / provisional holds adversarial | 12 / 62 / 28 passed, 0 failed | 12 / 62 / 28 passed, 0 failed |

Each pass starts from the CI-reset staging database (clean build) and the suites' own FK-ordered teardown. No fix was made between pass 1 and pass 2.

## 9. Cron evidence (production)

- Vercel → demohub → Settings → Cron Jobs: toggle **Disabled** at start of order (screenshot) → **Enabled** (screenshot) 2026-09-03. Schedules: brand-account cron 14:00 UTC daily; coi-enforcement hourly; provisional-sweep */15; refund-worker */15; seed-demo reset 03:00 UTC (scoped to `harvest-lane-demo`, `is_demo=true`; `wipeExistingDemo` filters on `retailer_id`; Gus rows untouched).
- Database `cron_heartbeat` rows (UTC, prod):

| ran_at | cron_name | outcome | trigger |
|---|---|---|---|
| 08:35:27 | refund-worker | succeeded (531 ms) | manual "Run" (Vercel) |
| 08:35:32 / 08:35:34 | daily | started / succeeded (1788 ms) | manual "Run" (Vercel) |
| **08:45:07** | **refund-worker** | **succeeded** | **scheduled (*/15)** |
| **08:45:22** | **provisional-sweep** | **succeeded** | **scheduled (*/15)** |

- Public status (`POST /api/find-retailer {action:"status"}`): 08:32Z `degraded` (no heartbeats yet) → 08:36Z **`operational`**, `cron.ok: true`, jobs `refund-worker {ok:true, required:true}`, `provisional-sweep {ok:true, required:false}`, `daily {ok:true, required:true}`; re-read 08:53:29Z still `operational`.

## 10. Controlled production proof (2026-09-03, build `4592ed3`)

| Step | Evidence |
|---|---|
| Deploy exact SHA | `/api/version` → `{"build":"4592ed3"}` at 08:32:27Z |
| Bindings identify production | Every write below landed in `dkgjvsstbgnhcfboqqnd`; Stripe objects are `cs_live_…` / `pi_…` live-mode; status route reports the prod heartbeat table |
| Containment | `POST /api/retailer-signup` → **403 `public_signup_disabled`**; holds off (status shows `provisional-sweep required:false`, only possible with the flag false); Gus venues all `max_demos_per_slot = 1`; `retailer_admins role=viewer` → 0; active holds → 0 |
| Controlled brand signs in | New brand via email code at `/r/gus`; brand id `75285ff4…`, created 08:35:40Z |
| Updates own profile | `company_name`, `contact_name`, `website`, `phone` persisted at 08:37:17Z (portal Profile → Save) |
| COI uploaded (normal workflow) | 7.5 KB PDF via portal dropzone → `coi_verifications` `9edacfce…` `pending` 08:42:00Z. Note: the 3 KB minimum-size guard correctly rejected an earlier 901-byte file. |
| COI approved (normal workflow) | David in `/owner` COI Review → `coi_verification_status: approved`, `is_verified: true`, expiry 2027-03-06 |
| Booking created | Mission District (fee set to $1 for the proof, reverted to $30 after) Sep 22 2026 11:00 AM → booking `8ee26656…` 08:47:59Z; agreement signed 08:47:58Z |
| Exact live amount captured | Stripe Checkout `cs_live_a1bj…`, PaymentIntent `pi_3UBWJyPSiN5YlLGb0hdqyQiO`, charge `ch_3UBWJyPSiN5YlLGb0XAWih8D`, **100 cents**; booking `payment_status: paid`, `amount_paid: 100` |
| Ledger agrees with Stripe | `payment_groups 8945cad8…` total 100 `paid`; `payment_allocations` customer 100 / venue 100 / platform 0; `processed_stripe_events` `payment_intent.succeeded` 08:48:37Z + `checkout.session.completed` 08:48:38Z both `completed` |
| Retailer confirms | Gus admin → **Confirmed** (Upcoming Demos row, COI ON FILE, expires 2027-03-06) |
| Cancel/refund via app path | Gus admin cancel → toast "Demo cancelled. Refund submitted to the brand" → `refund_requests 3a30cd1e…` amount 100 reason `cancelled` → **`succeeded`**, idempotency key `rf-3a30cd1e…`, Stripe refund **`re_3UBWJyPSiN5YlLGb000Lccqo`**; booking `cancelled` / `payment_status: refunded` / `refunded_at` 08:52:10Z; one `refund_operations` row (100, succeeded) |
| Refund verified once, in Stripe and ledger | `processed_stripe_events` `refund.created` + `charge.refunded` 08:52:11Z `completed`; allocation `refunded_amount: 100`, `reserved_refund_amount: 0`; payment group `refunded`. Exactly one refund object. |
| No sibling or unrelated booking changed | `bookings` in prod: **1 row total** (the test booking); no other rows exist to change |
| Refund-worker + public status remain green | heartbeats §9; status `operational` at 08:53:29Z |

No card data, session material, or secrets appear above. Brand contact details beyond first/last name are omitted.

## 11. Gates

| Gate | Result | Evidence |
|---|---|---|
| G1 — COI isolation | **PASS** | §5 rows 1–6; `isolation_matrix` 45/45 vs 13 pre-fix failures; CI pass 1 & 2 |
| G2 — Viewer isolation | **PASS** | §5 rows 7–12 (two retailers, two venues, HTTP response level) |
| G3 — Capacity/payment safety | **PASS** | §6; `capacity_guard` 32/32, ledger 62/62, holds 28/28; invariant `[]` on staging and prod |
| G4 — Worker health | **PASS** | §9: scheduled refund-worker heartbeat 08:45:07Z; sweep heartbeat 08:45:22Z proven while holds are OFF; status `operational`; Vercel cron toggle enabled |
| G5 — Final-SHA CI | **PASS** | §7: Ubuntu, Windows, clean build A/B, staging pass 1 & 2 all green on `4592ed3` |
| G6 — Product functions | **PASS** | §10: profile → COI → approval → booking → $1.00 live capture → confirm → cancel/refund `re_…Lccqo` |
| G7 — Deployment identity | **PASS** | §10 rows 1–2: `/api/version` = `4592ed3`; prod DB + live Stripe objects |
| G8 — Closed-launch containment | **PASS** | §10 row 3: signup 403, holds off, cap 1, 0 viewers, invitation-only |

## 12. Non-blocking follow-ups (P2/P3)

| Item | Owner | Deadline |
|---|---|---|
| **Gus admin tables overflow horizontally at full width** — `r/gus/admin/index.html` line 212 applies `white-space: nowrap` to every `td`; long status stacks + action buttons exceed the container. UI-only; fix = wrap text cells, keep nowrap on headers/date/actions. Ships as its own commit after this packet, with its own CI run. | Claude | 2026-09-03 (immediately after closure) |
| `verify.yml` `PRODUCTION_REF_DENIED` names the retired project (`ecapm…`), not `dkgjv…`; harmless because the positive `STAGING_REF_EXPECTED` check already refuses any other target. Update the value. | Claude | next CI touch |
| `status/index.html` (~lines 247–249) still reads `checks.cron.hours_since/outcome` (no longer sent) → shows "never"; render per-job `jobs[*].ok` instead | Claude | next UI release |
| Yahoo/AOL deliverability: enroll demohubhq.com in Yahoo Sender Hub (reputation, not config) | David | before public launch |
| Delete retired Supabase project `ecapmcyumpjjgjwuokyv` after backup | David | post-pilot |
| Test brand `Launch Proof Foods` (`75285ff4…`) and its cancelled/refunded booking remain in prod as the audit trail for this proof; scrub or keep per David | David | post-pilot |

## 13. Recommendation

**GO — CLOSED GUS PILOT**

All eight gates PASS with direct evidence on the single immutable SHA `4592ed3`, which is what production serves. Public retailer signup stays off, provisional holds stay off, Gus capacity stays at 1, and no viewer accounts exist. Public/full launch remains NO-GO until the fast-follow items are scheduled and a public-launch order is issued.
