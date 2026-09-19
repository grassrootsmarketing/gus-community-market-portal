# Demohub Release B — cutover closure note (2026-09-19)

**From:** Claude (implementation), for David. **To:** Codex. **One document.** This is the single closure record your `Execution-Results-2` review asked for (its "Cutover and launch completion criteria", item 7). Full timestamped log, gate outputs, snapshots' manifest and screenshots: `demohub-docs/evidence/cutover/` and `evidence/preview-journey/`.

## Result

**Release B is live in production.** `main` = production = `67613b5b1f7bb4ca1d69c94fb6eb26f8e367180d` (the reviewed SHA). Production ledger `0060…0072, 0074…0083` — 0073 absent. Ten migrations applied and recorded with **no error, no lost response, no re-paste, no forward repair.** Retained real data unchanged. Workers healthy on the new build before intake was restored. Window: 2026-09-18 22:59Z → 2026-09-19 00:36Z. Operator: David. No production charge, refund or email test was performed.

## 1. Pre-window work items (your W1–W4) — all closed

| Item | Closure | Evidence |
|---|---|---|
| W1 | Exposed staging key (`local_dev`, new-style secret key) deleted by David: old key **401 `Unregistered API key`**, replacement 200, Preview binding healthy | `evidence/cutover/2026-09-18-W1-old-key-revocation.md` |
| W2 | Preview-scoped `SITE_ORIGIN` (Production value untouched); preview accepts only its own origin; **real-browser journey 23/0** — sign-in link → profile → COI (pending review) → UI booking → agreement → Stripe hosted authorization → **returned into the Preview dashboard**, displayed "Slot held / not been charged" == backend == Stripe; on-the-wire `Origin` = preview + `Sec-Fetch-Site: same-origin`. Mail: **received `[SINK]` messages in the operator's allowlisted mailbox**, each showing its rewritten intended recipient, correlated to both journeys (confirmed delivery to the sink) | `evidence/preview-journey/` (`…browser…`, `2026-09-18-W2-mail-containment-record.md`, inbox screenshot) |
| W3 | Wrappers hardened exactly as specified: one identity row + `production` + `dkgjvsstbgnhcfboqqnd`; exact ordered ledger ≥ 0060 with 0073 absent; committed-marker refusal for 0074–0077 (builder asserts every explicit-COMMIT body has a marker and only those); ledger INSERT last, no conflict-ignore; full §3 gate as one result set with mandatory T1; bodies from `git show 67613b5:`; hashes frozen | `evidence/cutover/make-cutover-kit.mjs`, `cutover-kit-MANIFEST.json` |
| W4 | 16 wrapper scenarios executed **in the dashboard SQL editor** on a scratch schema with the same generator; in-page hash of each executed text == manifest; fresh-connection inspection after each; every outcome as designed; no failed transaction left open; scratch schema dropped; real identity/ledger untouched | `evidence/cutover/2026-09-18-W4-wrapper-test-results.md` |

Evidence labels corrected as you required (deployed error case = authorization cancelled before confirmation only; notification check = terminal convergence, not exactly-once; sweep overlap = safe in the tested case, loser's failure stays visible).

## 2. The window

| Time (UTC) | Step | Result |
|---|---|---|
| 22:59 | Authorization by David in chat; pre-window probe | build `32e1418`, checkout reachable |
| 23:01 | **Contain:** Production `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false`, old build redeployed | `POST /api/checkout` → **503 `checkout_disabled`** on `32e1418` |
| **23:03:18** | **T0** — Vercel Cron Jobs disabled. Operator freeze (David sole operator; production held 0 bookings) | five jobs listed, toggle off |
| 23:05 | Function duration: no `maxDuration` in either build, no project override, Fluid Compute on Pro → drained for the **plan maximum, 800 s**, not the 300 s default | **T1 = 23:16:38** |
| 23:06 | Vercel production logs | last scheduled invocations 23:00:00–23:00:22, all 200, all before T0; afterwards only this cutover's probes, plus one stateless `GET /api/stripe-webhook` → 405 at 23:14:59 (a browser opening the URL; no handler work) |
| 23:17–23:24 | **Stripe deliveries.** A graph of 41 failed deliveries on 9/17–9/18 turned out to belong to two stale **sandbox** endpoints (created June/July) pointing at the production URL: every sandbox test event from this week's test runs was also sent to production and failed there (apex-host redirect; a test event cannot verify against the live secret). Production recorded none (last processed event 2026-09-05; 0 non-completed). Both sandbox endpoints **disabled** via the Stripe API (test mode, reversible). **Live endpoint:** `https://www.demohubhq.com/api/stripe-webhook`, Active, 17 events, **0 deliveries / 0 failed** this week; viewed inside the Demohub account, which also settles the account-ownership question you raised | screenshots in `evidence/cutover/` |
| 23:35:51 | **Gate run 1** (SQL editor, David, T1 literal filled) | identity `1 / production / dkgjvsstbgnhcfboqqnd`; ledger exactly `0060…0072`; every stop row 0; open cases 0; per-job heartbeats 23:00Z succeeded, none after T1; no fulfilment/event/booking touch after T1; app DB activity 0; events last 3 days none; data `3 / 10 / 33 / 10 / 0 / 0` |
| 23:36:32 | **Gate run 2** (read-only REST, immediately before migrations) | section A all 0, no non-completed events, heartbeats unchanged. Identity and exact history are re-asserted inside every paste |
| 23:45–00:09 | **Ten pastes**, each loaded from the frozen kit with a clipboard-vs-manifest hash check, each whole file run once | table below |
| 23:47 / 00:10 | At David's request: two read-only full data snapshots (42 tables) — one after paste 1, one after paste 10 | every pre-existing column of every retained row **identical**; only addition `venues.availability_version`. Kept locally outside git (real contact data). **Disclosed:** no snapshot was taken before paste 1; Supabase daily physical backups exist (Pro plan), latest 2026-09-18 09:48Z, i.e. before the window |
| 00:10:29 | David: "deploy" → `git push origin 67613b5:main` (fast-forward `32e1418..67613b5`) | — |
| 00:10:52 | **Deployed, intake still off** | `/api/version` → `67613b5`; checkout still 503; `/gussmarket` 307 → `/r/gus`, `/gussmarket/admin` 307 → `/r/gus/admin`; `/r/gus` 200; public data returns Gus's Community Market with its 5 real venues |
| 00:17:19 | **Final verification** (SQL editor) | identity exact; ledger `0060…0072,0074…0083`; `projection_anomalies`, `offering_anomalies(invariant)`, `snapshot_drift`, `schedule_mismatches`, `capacity_invariant_violations` all **0**; fulfilment work 0; open cases 0; retailers/venues/contacts/demos **3 / 10 / 33 / 10** |
| 00:19–00:22 | **Workers first:** Production `NOTIFICATION_WORKER_ENABLED=true`, cron re-enabled, redeploy | status lists notification-worker as required |
| 00:30:02–00:30:22 | First scheduled tick on the new build | `notification-worker`, `refund-worker`, `provisional-sweep` — **all `succeeded`**; public status `operational` |
| 00:33–00:36 | **Intake last:** Production `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true`, redeploy; `SLOT_EDITING_ENABLED` unset | checkout → 401 `sign in to book` (no longer 503); provisional-sweep now required (holds flag effective); status `operational`. Freeze lifted |

### Paste results (kit file sha256 prefix · migration body sha256 prefix · dashboard result)

| # | Version | Kit file / body | Result row |
|---|---|---|---|
| 1 | 0074 | `e7e892909848` / `5b5da29884cd` | `OK 0074 RECORDED (1/10)` · ledger `0072,0074` · bookings cols 3 · notification_events present · demo_notifications (absent) |
| 2 | 0075 | `a334b5bae9bd` / `261df5a856bb` | David reported done without pasting the row; independently confirmed read-only (all 10 venues carry a non-null `availability_version`) and then by paste 3's exact-history guard and result |
| 3 | 0076 | `5aac79698ccd` / `9d15b20a4667` | `OK 0076 RECORDED (3/10)` · ledger `0072,0074,0075,0076` · invariant anomalies 0 |
| 4 | 0077 | `7800e57bfed7` / `c81507ea8034` | `OK 0077 RECORDED (4/10)` · `booking_transition(uuid,uuid,text,jsonb,numeric)` · projection anomalies 0 |
| 5 | 0078 | `e5fec32f6e1e` / `fe6ebe4096f2` | `OK 0078 RECORDED (5/10)` · old 6-arg (absent) · null generation 0 |
| 6 | 0079 | `0529e0b486d3` / `6a37ed52d98a` | `OK 0079 RECORDED (6/10)` · `… p_copy_slots boolean DEFAULT false` |
| 7 | 0080 | `bf862bf7c39a` / `4376097d0081` | `OK 0080 RECORDED (7/10)` · trigger count 1 |
| 8 | 0081 | `2cf38482bd09` / `57e454c5fcc0` | `OK 0081 RECORDED (8/10)` · old case fn (absent) · claimless record `stale` |
| 9 | 0082 | `6d6ae76dc834` / `0fb84863b3cd` | `OK 0082 RECORDED (9/10)` · unstamped active 0 |
| 10 | 0083 | `b2a67a940150` / `ca7666dc2e20` | `OK 0083 RECORDED (10/10)` · ledger `0072,0074,…,0083` · outbound col 1 · claimless freeze `stale` · non-empty outbound 0 |

## 3. Final state

- Deployment: `www.demohubhq.com` build `67613b5`; tree identical to the reviewed candidate.
- Flags (Vercel **Production**): `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true`, `NOTIFICATION_WORKER_ENABLED=true`, `SLOT_EDITING_ENABLED` unset.
- Cron: enabled, six jobs; first new-build heartbeats succeeded.
- Named operator for failed workers, unresolved payments and parked messages: **David**.

## 4. Not done / not verified — stated plainly

1. **No production payment, refund or email test.** The first real booking will be the first real payment on the new code. A small live charge-and-refund smoke needs David's separate authorization (amount, operator-owned card).
2. **Production operator probe not run.** `/api/version`'s operator view needs the production cron secret, which I do not hold. Production binding validity is inferred from behaviour: every route answers normally (a binding failure returns `503 binding_invalid` on all of them), status `db.ok`, live Stripe endpoint active, flags observable through the status page's required-job list and the checkout 503→401 transition.
3. Paste 2's result row was not captured verbatim (see table).
4. ~~Two other pre-rotation test-project secret keys not confirmed deleted~~ — **resolved 2026-09-19T00:50Z:** David deleted `github_actions` and `vercel_preview`; only `rotated_2026_09` remains; rotated key 200, Preview binding healthy, production unaffected.
5. The Grassroots Demos Stripe **test** key remains David's accepted-risk exception; absent from every Demohub binding.
6. Housekeeping still open: Vercel **Ignored Build Step** is `Automatic` (restore `Only build production`); ~~the operator workstation's Supabase CLI is still linked to production~~ **resolved 2026-09-19:** the local link folder was set aside, so `--linked` commands no longer resolve to production; Supabase backups exclude Storage objects (COI files).
7. Observations carried forward, no change made: overlapping `provisional-sweep` loser answers 500 while state converges; brand dashboard tile reads "No COI on file" while a certificate is pending review.

## 5. Where everything is

`demohub-docs`: `evidence/cutover/2026-09-18-cutover-log.md` (timeline), `…gate-1-sql-editor.md`, `…gate-2-rest-immediately-before-migrations.json`, `…production-baseline.json`, `…W1…`, `…W4…`, `cutover-kit-MANIFEST.json`, `make-cutover-kit.mjs`, Stripe screenshots; `evidence/preview-journey/` (HTTP journey 104/0, browser journey 23/0, mail record); `docs/release-b-cutover-runbook.md` (v5.1); `docs/release-b-w1-w4-completion-record.md`. Operator kit as executed: `Documents/Codex/cutover-kit/`.

**The reviewed Release B cutover requirements are met for the closed MVP pilot, with the exceptions listed in §4.**
