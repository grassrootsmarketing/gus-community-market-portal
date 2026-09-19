# Demohub Release B — cutover closure note (2026-09-19, final)

**From:** Claude (implementation), for David. **To:** Codex. **One document.** This is the single closure record your `Execution-Results-2` review asked for (its "Cutover and launch completion criteria", item 7). Full timestamped log, gate outputs, snapshots' manifest and screenshots: `demohub-docs/evidence/cutover/` and `evidence/preview-journey/`.

## Result

**Release B is live in production.** `main` = production = `67613b5b1f7bb4ca1d69c94fb6eb26f8e367180d` (the reviewed SHA). Production ledger `0060…0072, 0074…0083` — 0073 absent. Ten migrations applied and recorded with **no error, no lost response, no re-paste, no forward repair.** Pre-cutover counts and final checks agree, and the two post-0074 snapshots show unchanged existing values through 0083 (no pre-0074 content snapshot was captured). Workers healthy on the new build before intake was restored. Window: 2026-09-18 22:59Z → 2026-09-19 00:36Z. Operator: David. After the window: a separately authorized **$1 live hold → capture → refund smoke passed** (§4) and the post-launch housekeeping was completed (§5).

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
| 23:36:32 | **Gate run 2 — a NARROWER read-only REST check, not a second complete SQL gate** (process deviation, recorded as such): section A all 0, no non-completed events, heartbeats unchanged. Paste 1 began at 23:45:30Z, nine minutes later. Each paste re-asserts identity and exact history, but those guards do not re-check activity/drain conditions | accepted by Codex for this execution; for the next incompatible migration the complete gate is run at the actual execution point and repeated after any delay or intervening activity |
| 23:45–00:09 | **Ten pastes**, each loaded from the frozen kit with a clipboard-vs-manifest hash check, each whole file run once | table below |
| 23:47 / 00:10 | At David's request: two read-only full data snapshots (42 tables) — one after paste 1, one after paste 10 | **Pre-cutover counts and final checks agree; the two post-0074 snapshots show unchanged existing values through 0083. No immediate pre-0074 content snapshot was captured** (Codex's wording). Only addition between the two: `venues.availability_version`. Kept locally outside git (they include auth/session tables as well as contact data). The platform's daily physical backup of 2026-09-18 09:48Z predates the window — a recovery resource, not a comparison that was performed |
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
- Cron: enabled, six jobs; first new-build heartbeats succeeded; public status `operational`.
- Platform backups: demohub-prod is on the Pro plan with daily physical backups (latest before the window: 2026-09-18 09:48Z). Storage objects (COI files) are not covered by database backups.
- Named operator for failed workers, unresolved payments and parked messages: **David**.

## 4. Live payment smoke — separately authorized by David, passed (2026-09-19 01:12–01:18Z)

Own card, **$1.00**, on a dedicated internal retailer (`zz-demohub-live-smoke-0919`, keeps-all, manual confirm, **no store contacts**, so Gus's staff were never notified). Every Stripe event below was delivered by Stripe to the live endpoint and reached `completed` in the event inbox. Evidence: `evidence/cutover/2026-09-19-live-payment-smoke.md`.

| Step | Live result |
|---|---|
| Signup + booking | David signed up a real brand through the live site (email verification on the new build) and booked **without a COI**; the form stated "temporary hold (not a charge)" |
| **Hold** | `payment_intent.amount_capturable_updated` + `checkout.session.completed` → booking `held` / `authorized`, 24 h window set, group `authorized` $1.00, held-stage fulfilment generation 1 done; **no demo, no case**. Hold email received from `bookings@demohubhq.com`: "hold on your card for $1.00 — you have not been charged", correct store/date/time (real mail, no sink) |
| COI | Uploaded in the live dashboard → "Pending review" (AI auto-check is off in production by design). Owner approval through the live route → 200; **no capture on approval** for a manual-confirm retailer |
| **Capture** | Retailer confirm → 200 `{ok, demo_id, email_sent}`; `payment_intent.succeeded` → booking `confirmed` / `paid`, group `paid`, fulfilment re-issued as **generation 2** and done, **exactly one demo** (1 h); no case |
| **Refund** | Retailer cancel → 200 `{refund_status:"submitted", demo_cancelled:true}`; `charge.refunded` + `refund.created` → booking `cancelled` / `refunded`, allocation 100 / refunded 100, refund request **succeeded** with a Stripe refund id, 0 retries, demo cancelled; no case |
| After | `projection_anomalies`, `snapshot_drift`, `offering_anomalies(invariant)`, `schedule_mismatches` all 0; open reconciliation cases 0; status `operational`; one notification delivery (`owner_booking_created` → owner, accepted) |

Limits: Claude holds no live Stripe key, so Stripe-side figures were not read independently — the evidence is the ledger plus Stripe-delivered webhooks; David can confirm the $1.00 fully refunded payment in the Demohub dashboard. Uncertain-outcome and captured-but-unapplied paths were **not** exercised live (they remain covered by the accepted fault-injection suites only).
Left in production by David's decision, for future smokes: the internal retailer and its $1 venue, two brand rows under David's own mailbox, and the terminal booking/payment/refund/demo rows (real financial records are not deleted). Its welcome mails are marked sent and its monthly summary is off, so no cron mails about it; retailers are listed only in the owner console.

## 5. Post-launch housekeeping — done

- The two remaining pre-rotation secret keys on the **test** project (`github_actions`, `vercel_preview`) deleted by David; only `rotated_2026_09` remains (rotated key 200, Preview binding healthy, production unaffected).
- The operator workstation's Supabase CLI link to **production** removed (link folder set aside; `--linked` commands no longer resolve to production). Staging resets stay on the guarded CI jobs.
- Vercel **Ignored Build Step** restored to production-only and verified (a branch push answered "Canceled by Ignored Build Step"; production unchanged).
- Two stale Demohub-**sandbox** webhook endpoints that targeted the production URL disabled (§2).

## 6. Not done / not verified — stated plainly

1. **Production operator probe not run.** `/api/version`'s operator view needs the production cron secret, which Claude does not hold. Production binding validity is inferred from behaviour: every route answers normally (a binding failure returns `503 binding_invalid` on all of them), status `db.ok`, live Stripe endpoint active, flags observable through the status page's required-job list and the checkout 503→401 transition — and, since §4, a complete live payment cycle.
2. Paste 2's result row was not captured verbatim (confirmed read-only and by paste 3's exact-history guard and result).
3. No content snapshot was taken before paste 1, so preservation **across 0074** rests on matching pre-cutover counts and final checks, not on a row comparison; the two snapshots compare post-0074 → post-0083 only.
4. The second gate was a narrower REST check rather than a complete SQL gate at the execution point (§2).
5. The Grassroots Demos Stripe **test** key remains David's accepted-risk exception — not a closed revocation; revocation is still recommended. It is absent from every Demohub binding.
6. Observations carried forward, no change made (candidate frozen; copy out of scope): overlapping `provisional-sweep` — the losing invocation answers 500 while state converges; the brand dashboard's Overview tile reads "No COI on file" while a certificate is pending review (the Compliance tab reads "Pending review" correctly).

## 7. Where everything is

`demohub-docs`: `evidence/cutover/2026-09-18-cutover-log.md` (timeline), `…gate-1-sql-editor.md`, `…gate-2-rest-immediately-before-migrations.json`, `…production-baseline.json`, `2026-09-19-live-payment-smoke.md`, `…W1…`, `…W4…`, `cutover-kit-MANIFEST.json`, `make-cutover-kit.mjs`, Stripe screenshots; `evidence/preview-journey/` (HTTP journey 104/0, browser journey 23/0, mail record); `docs/release-b-cutover-runbook.md` (v5.1); `docs/release-b-w1-w4-completion-record.md`. Operator kit as executed: `Documents/Codex/cutover-kit/`.

**The reviewed Release B cutover requirements are met for the closed MVP pilot, and a live hold → capture → refund cycle has passed on the deployed build. Remaining caveats are the six items in §6.**

**Codex disposition (2026-09-19, `Demohub-Release-B-Closure-Acceptance-and-Pilot-Followups-2026-09-19.md`): Release B accepted for the closed MVP pilot; W1–W4 closed; the wording above reflects its two evidence corrections. Follow-ups A–E are tracked in `docs/release-b-pilot-followups.md` as normal operations, not launch gates.**
