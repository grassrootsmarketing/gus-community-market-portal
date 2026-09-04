# Demohub — Final Cleanup Closure Packet (Codex FC-01 … FC-04)

**Responds to:** Codex "Final Cleanup Handoff for Claude Code" (2026-09-04). Pilot decision at start: **GO — CLOSED GUS PILOT** on `fdc87df`.
**Prepared:** 2026-09-04 · **Branch:** `cleanup/codex-final` (from `origin/main` = `fdc87df`)
**Decision:** see §12

---

## 1. Baseline and final SHA

| Item | Value |
|---|---|
| Baseline (`origin/main` = production) | `fdc87df5f628628cc5793d24b7001f7b9c8d044b`, tree clean |
| Cleanup RC (final SHA) | `9dc82caaaac308a2a8ec39c78cd77fac0db89123` |
| Working tree at RC | clean (`git status --porcelain` → 0) |
| SQL migrations | 73 (`0000`–`0072`) + `README.md` (not a migration) = 74 files on disk |
| Test database | Supabase project **demohub-rebuild-check** (`tileejdviuvijumjeplv`) |
| Production database | Supabase project **demohub-prod** (`dkgjvsstbgnhcfboqqnd`) |
| Containment during the round | Gus only retailer · public signup OFF · provisional holds OFF · Gus capacity 1 · no viewer accounts · production kept on `fdc87df` until the gate passed · Gus `allow_support_access=false` |

## 2. Changed files

`api/admin-auth.js` · `api/venues-bulk-import.js` · `r/gus/admin/index.html` (support-activity card only) · `package.json` (test wiring) · `.github/workflows/verify.yml` (EXPECTED_MIGRATIONS 73) · `tools/check-sql-columns.mjs` (keyword list) · `tests/support_access.test.mjs` · `tests/session_transport.test.mjs` · **new** `supabase/migrations/0072_support_access_atomic.sql` · **new** `tests/support_access_race.test.mjs` · **new** `tests/venues_bulk_import.test.mjs`. Docs (this file and the corrected Round-2 packet) live on branch `docs/closure-round2`, never on `main`.

## 3. FC-01 — Migration-history reconciliation

**Root cause.** Production migrations have been applied through the Supabase SQL editor, which changes the schema but does not write `supabase_migrations.schema_migrations`. Test-database history is complete because CI's clean build applies the chain via the CLI.

**Inspection (read-only), project refs positively compared in every query result:**

| | demohub-rebuild-check (`tileejdviuvijumjeplv`) | demohub-prod (`dkgjvsstbgnhcfboqqnd`) |
|---|---|---|
| Ledger before | 72 rows, `0000`–`0071` (independently read over direct Postgres) | **62 rows**, highest `0061` (operator-run SQL, result table pasted) |
| `enforce_slot_capacity()` contains `FOR SHARE` | true | true |
| `enforce_slot_capacity_on_move()` contains `FOR SHARE` | true | true |
| `venues_max_demos_per_slot_min` validated | true | true |
| `compliance_records_contact_same_retailer` validated | true | true |
| `compliance_tenant_anomalies()` exists | true | true |
| `capacity_invariant_violations(null,false)` rows | 0 | 0 |
| `compliance_tenant_anomalies()` rows | 0 | 0 |

**Repair (metadata only, production, operator-run):** `insert into supabase_migrations.schema_migrations (version, name) values ('0070','capacity_serialization'), ('0071','compliance_tenant_integrity') on conflict (version) do nothing;` — the same effect as `supabase migration repair --status applied`. Ledger after: `0000`–`0061`, `0070`, `0071` (64 rows). No application rows touched.

**Appendix observation (not repaired, per the order's scope rule):** production's ledger lacks `0062`–`0069` although their schema effects are present (e.g. `capacity_invariant_violations()` from 0069 and the 0068 columns are in use). Recommended follow-up: verify each of the eight migrations' postconditions individually, then repair those entries. Until then, do not run `supabase db push` against demohub-prod. After 0072 is applied to production (§10) its ledger entry must be added the same way.

## 4. FC-02 — Support-access consent, atomic sessions, revocation

**Root cause.** Consent was enforced (Round 2) but: no visible switch, startup never loaded consent state, OFF did not revoke live sessions, and session + audit were two REST writes with compensating delete.

**Fix.** `0072_support_access_atomic.sql`:
- `support_session_create(p_retailer_id, p_owner_email, p_session_email, p_ip_address, p_user_agent)` → `(session_id, expires_at)`: `SELECT … FOR NO KEY UPDATE` on the retailer; refuses (`P0001 support_access_disabled`) unless `allow_support_access IS TRUE` and `support_access_expires_at > now()`; `expires_at := LEAST(now() + 4h, consent)` computed **in the database**; inserts `admin_sessions` then `support_sessions` in one transaction; any failure rolls back both.
- `support_access_set(p_retailer_id, p_enabled)` → `(allow_support_access, support_access_expires_at, ended_sessions)`: same lock; ON = consent 24 h; OFF = consent cleared, every open `support_sessions` row stamped `ended_at`, then their `admin_sessions` deleted (audit before revoke, so `ON DELETE SET NULL` cannot erase owner/retailer/timestamps/`writes_count`).
- Both `SECURITY DEFINER`, `service_role` only; post-condition block asserts existence, definer, grants. `FOR NO KEY UPDATE` (not `FOR UPDATE`) so consent toggles never block FK-child inserts (bookings/venues) that take `FOR KEY SHARE`.

`api/admin-auth.js`: `owner-impersonate` = owner auth (401) → uuid (400) → retailer exists (404) → RPC; `support_access_disabled` → 403 uniform body; anything else → 500 `audit_unavailable`, no cookie; cookie Max-Age derived from the RPC's `expires_at`. Two-write path removed. `support-access-toggle` / `-status` / `support-sessions` pass through `requireRetailerMembership` 401/403/503 instead of rewriting to 401; viewer role → 403.

Dashboard (`r/gus/admin/index.html`, support-activity card): `#supportAccessToggle` (`role="switch"`, `aria-checked`), subtitle from server state, copy: "ON allows Demohub support to sign in to your admin for up to 24 hours. Each support session lasts at most four hours and never beyond that consent window. OFF immediately ends any active Demohub support sessions." `_loadSupportAccessStatus()` runs at startup; stale "toggle removed" comment deleted; no session ids/cookies in page JS.

**Evidence (demohub-rebuild-check, RC tree):** `tests/support_access.test.mjs` **125/125** — OFF → 403 with zero `admin_sessions` and zero `support_sessions` rows; expired consent → 403; valid consent → exactly one session + exactly one matching audit row; forced audit failure via direct RPC with `p_owner_email = null` (audit `NOT NULL` violation after the session insert) → zero `admin_sessions` rows, no compensation involved; consent 2 h → session ≈ 2 h; consent 10 h → ≈ 4 h; OFF with active session → `ended_at` set, `admin_sessions` row deleted, old cookie → 401 on next protected request; viewer cannot change consent (403); membership backend 503 passes through; dashboard static checks (switch id, startup load, toggle wiring, copy); 30 response bodies × 7 secrets leak scan clean. `tests/support_access_race.test.mjs` **29/29** — (A) create then OFF revokes; (A2) OFF blocks on an in-flight create, then revokes it; (B) create blocks on OFF's lock, then `P0001`; (C) **race: 100 runs, 0 usable-after-OFF, 0 deadlocks**. `tests/session_transport.test.mjs` 76/76.

## 5. FC-03 — Strict server-side CSV capacity

**Root cause.** `api/venues-bulk-import.js` coerced `max_demos_per_slot` with `Math.max(1, parseInt(v,10) || 1)` and logged-and-continued when the tier precheck failed.

**Fix.** `parseCapacityStrict()`: blank/absent → default 1; otherwise `^[0-9]+$` and `1 ≤ n ≤ 2147483647`; rejects `0`, `-1`, `2.7`, `1.0`, `1e2`, `+3`, `abc`, `NaN`, `0x10`, overflow, full-width digits. Every row validated before any insert → 400 `invalid_rows` (row-numbered, non-sensitive) with zero inserts. Tier/retailer lookup failure → 503 `entitlement_unavailable`, zero inserts. `enforce_venue_limit()` remains authoritative: trigger refusal → 409 `venue_limit_reached` with accurate `imported`/`failed`; other DB error → 500; never `ok:true` on partial. Same-origin and role checks unchanged.

**Evidence:** `tests/venues_bulk_import.test.mjs` **78/78** — defaults, exact values, twelve rejected literals each with zero inserts, whole-file rejection, both 503 fault paths, trigger refusal 409 with `imported 1 / failed 2` and exactly one venue in the DB, viewer/manager 403, no cookie 401, cross-origin 403 with no venue write and venue count unchanged. `tests/capacity_input.test.mjs` 75/75 unchanged.

## 6. FC-04 — Round-2 packet corrections (branch `docs/closure-round2`, commit `05ced23`)

§9 heading now names `fdc87df` (`fdc87df5f628628cc5793d24b7001f7b9c8d044b`, the run API's `headSha`); migration count stated as 72 SQL + one README; anonymous-probe row states the request shape (no cookie, no `Origin` → 401; foreign `Origin` → 403 `cross_origin_denied`); SQL-editor results marked operator-attested vs. independently repeatable checks; the F-06 "UI copy already matched" statement is superseded by §4 above (the switch was absent at that time; it now exists with test evidence).

## 7. Local verification (final cleanup tree)

`npm run check` ✓✓✓✓ (73 migrations, 46 api modules, no-undef, binding) · `npm run check:columns` ✓✓ · `npm test` 17/17 suites · route flows 182 · session transport 76 · support access 125 · support access race 29 · venues bulk import 78 · capacity input 75.

## 8. Staging database checks

- 0072 applied to demohub-rebuild-check once via direct Postgres (recorded in its ledger as `0072 support_access_atomic`); clean chain `0000`→`0072` from zero twice = CI clean build A/B (§9).
- Full staging suite twice consecutively = CI staging pass 1 / pass 2 (§9). The race test's 100-run stress runs inside both passes.

## 9. GitHub Actions — exact SHA gate

PENDING

## 10. Production

PENDING (0072 not yet applied to demohub-prod; production still serves `fdc87df`).

## 11. Unrelated observations (appendix, unchanged)

- Production ledger gap `0062`–`0069` (§3).
- Client bulk-import UI shows `Upload failed: <error code>` for non-2xx; the server now returns row-level `errors[]` it could render.
- Secrets pasted into chat by screenshot on 2026-09-04 (test-DB password, Stripe **test** key): rotate after the pilot settles.

## 12. Decision

PENDING
