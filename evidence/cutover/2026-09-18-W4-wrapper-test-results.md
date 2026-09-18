# W4 — wrapper tests, executed in the Supabase dashboard SQL editor (demohub-rebuild-check), 2026-09-18

Execution path: the dashboard SQL editor of project `tileejdviuvijumjeplv` (the operator's logged-in browser session). Each file's text was loaded into the editor and **Run** pressed once; the dashboard's own confirmation dialogs ("Run query" / "Run without RLS") were answered. Before each run the editor content's byte length and sha256 prefix were computed **in the page** and match the generated file (`wrapper-tests-MANIFEST.json`). After each scenario the state was read over a **separate, fresh database connection** (session pooler).
Fixtures: scratch schema `cutover_kit_wrapper_test_20260918` only — mock `identity()` (rows `production / dkgjvsstbgnhcfboqqnd`), mock ledger `schema_migrations` seeded `0060…0072` (no primary key, so the duplicate check is the guard's own), `sim_bookings`, `sentinel`. Wrappers are produced by the **same `wrap()` generator** as the production kit; only the identity function, the ledger table and the marker reference are substituted. Real identity (`staging / tileejdviuvijumjeplv`), the real ledger (`…0083`), bookings and functions were never touched.

| # | File (sha256 prefix as run) | Dashboard result | State afterwards (fresh connection) |
|---|---|---|---|
| 00 | setup (`7bb76e0fc9f6`) | 1 row | ledger `0060…0072`, no marker, sentinel 0 |
| 01 | wrong environment (`00892caa2bcb`) | `ERROR P0001 CUTOVER GUARD: environment is staging, expected production — STOP` | unchanged: sentinel 0, identity still production (the fixture mutation rolled back with the batch) |
| 02 | wrong project (`24e819099279`) | `… project_ref is tileejdviuvijumjeplv, expected dkgjvsstbgnhcfboqqnd — STOP` | unchanged |
| 03 | two identity rows (`cc8769298658`) | `… expected exactly one deployment identity row, found 2 — STOP` | unchanged |
| 04 | missing historical version 0066 (`6ca5ccd34119`) | `… ledger from 0060 is [0060,…,0065,0067,…,0072], expected exactly [0060,…,0072] … — STOP` | unchanged |
| 05 | unexpected 0073 (`6bc3f70ee585`) | `… ledger from 0060 is [0060,…,0072,0073], expected exactly [0060,…,0072] … — STOP` | unchanged |
| 06 | duplicate 0072 (`5812a4d0e8ea`) | `… 1 duplicated ledger version(s) — STOP` | unchanged |
| 07 | wrong predecessor — 0078 pasted when 0074–0077 are missing (`70d1a38b8bd7`) | `… ledger from 0060 is [0060,…,0072], expected exactly [0060,…,0072,0074,0075,0076,0077] … — STOP` | unchanged — **sentinel 0 after all seven refusals: every guard stopped before the first write** |
| 08 | explicit-COMMIT file, failure **before** COMMIT (`5e0b54d48077`) | `ERROR P0001 SIMULATED failure BEFORE the explicit COMMIT` | **no marker, sentinel 0, no 0074 row** — nothing committed; 0 idle-in-transaction sessions |
| 09 | explicit-COMMIT file, failure **after** COMMIT (`6b120c3e89c8`) | `ERROR P0001 SIMULATED post-condition failure AFTER the explicit COMMIT` | **marker present, sentinel 1, NO 0074 row** — committed but unrecorded |
| 10 | re-paste of the same file after 09 (`f7f8fa087467`) | `… sim_bookings.start_at already exists but 0074 is not in the ledger — a previous paste committed and then failed. STOP AND INSPECT; do not re-paste` | unchanged (sentinel still 1) — **re-paste refused** |
| 11 | fixture reset (`d5b56055021a`) | 1 row | back to setup state |
| 12 | success, explicit file (`f7f8fa087467`) | 1 row (`OK 0074 RECORDED`) | marker present, sentinel 1, ledger `…0072,0074` — **one version recorded** |
| 13 | repeat of 12 | `… ledger from 0060 is [0060,…,0072,0074], expected exactly [0060,…,0072] … — STOP` | unchanged — **repeat refused** |
| 14 | implicit file, failure inside (`446d35f781c6`) | `ERROR P0001 SIMULATED failure inside an implicit-transaction file` | **`sim_implicit` absent, sentinel still 1, no 0078 row** — simulated migration and ledger insert rolled back together |
| 15 | success, implicit file (`dcb844f119c7`) | 1 row (`OK 0078 RECORDED`) | `sim_implicit` present, sentinel 2, ledger `…0072,0074,0078` |
| 16 | repeat of 15 | `… ledger from 0060 is [0060,…,0074,0078], expected exactly [0060,…,0074] … — STOP` | unchanged — repeat refused |
| 99 | cleanup (`526c5ebc6560`) | 1 row | scratch schema rows 0, scratch functions 0; real ledger `0073…0083` and real identity unchanged; 0 idle-in-transaction sessions |

Dashboard behaviour matched every assumption in the runbook and in Codex's W3 rationale: a batch stops at the first error; an explicit earlier COMMIT survives a later failure; a batch without explicit transaction statements is one implicit transaction; no failed transaction was left open after any deliberate error (checked after each of 08, 09, 14).

One harness note (not a product or kit issue): the first attempt to compose two test files in the page used `String.replace`, which collapses `$$` in the replacement text; the in-page hash check caught the 2-byte difference before anything ran, and the files were recomposed and re-verified. Every file that was actually executed matches its manifest hash.
