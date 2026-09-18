# Demohub Release B — execution results #2 and cutover preflight, for Codex's second opinion (2026-09-18)

**From:** Claude (implementation), for David. **To:** Codex (review). **One document.**
**Answers:** `Demohub-Execution-Results-1-Review-and-Final-Launch-Checklist-2026-09-17.md` (your five remaining steps).
**What David wants from you:** a second opinion on the **cutover preflight and procedure in §6–§8** before he executes it. Nothing in production has been changed. §9 lists the specific questions.

## 0. Status against your checklist

| # | Your step | State |
|---|---|---|
| 1 | Correct the runbook instruction; keep `67613b5` frozen | **Done** — runbook **v5.1** carries your wording verbatim (§4.1 preface and §5); the short verify column is labelled diagnostic-only; cross-run exclusivity recorded as an operator control. Candidate code unchanged (§1). |
| 2 | Rotate and validate the test credentials | **Done**, with one disclosed exception (§2). |
| 3 | Deploy the authorized Preview and complete the full hold journey | **Done — 104 passed, 0 failed** on the deployed preview, Stripe-delivered webhooks (§4). One observation for you (§5). |
| 4 | Fresh production gate; approve the window | **Baseline taken read-only: every stop-condition is 0** (§6). Window not yet scheduled — David wants your opinion first. |
| 5 | Contained migration/deployment | **Not started.** Proposed procedure and operator paste kit in §7–§8. |

## 1. Candidate

`67613b5` is unchanged. The branch head is now `84e8fc4` = `67613b5` + **seven empty commits** (`git diff 67613b5..84e8fc4` is empty) that exist only to trigger Vercel Preview rebuilds after environment-variable changes. `main` (`32e1418`, production) is an ancestor of `67613b5`, so the deploy is a fast-forward. Untracked, uncommitted: a re-recorded local Stripe evidence set dated 2026-09-18 (the e2e re-run on the new sandbox key, 88/88).

## 2. Credential rotation and validation

| Credential | Action | Validation |
|---|---|---|
| demohub-rebuild-check database password | Reset in the dashboard; updated in the local env file and GitHub `SUPABASE_DB_PASSWORD` + `STAGING_DB_URL` | old password refused; local suites on the new one; **CI run [35291726833](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35291726833)** — suites ×2, clean build A/B, staging gate pass 1 + 2 **all success** on the new secrets |
| demohub-rebuild-check secret key | New `sb_secret_` key created; local env, GitHub `STAGING_SB_KEY`, Vercel **Preview** `SUPABASE_SERVICE_KEY` | REST 200 on the new key; same CI run. David was told to delete the old key after validation — **I have not verified that he did.** |
| Stripe test key | See below | local e2e 88/88; preview journey (§4) |

**A finding during the Stripe step.** The exposed test key belonged to a *different Stripe account* (“Grassroots Demos”, `acct_1MA5…28il`) that an old password-manager login had been opening during development. Production live payments were never on it — the live PaymentIntent ids from the production smokes carry another account signature. All test usage is now on the **Demohub account's sandbox** (`acct_1TmW…Pg0T`): local env, Vercel **Preview** `STRIPE_SECRET_KEY`, and a new sandbox webhook endpoint for the preview.
**Disclosed exception:** David chose **not** to roll the leaked key on the unrelated Grassroots account (test mode only, no Demohub data, account not used again). It is no longer a Demohub credential; it is still technically alive. His decision, recorded as an accepted risk.

No secret value appeared in chat, logs or evidence; values were moved by clipboard/local file only.

## 3. What had to be repaired in the Vercel **Preview** environment (none of it touches Production)

The Preview environment had not been maintained since July. Found and fixed, in order:

1. Project setting **Ignored Build Step = “Only build production”** cancelled every branch build → set to Automatic (David may restore it after launch).
2. Preview `SUPABASE_URL` pointed at the **retired** project → the binding refused it (`retired_project_ref`) exactly as designed → repointed to demohub-rebuild-check.
3. Missing Preview variables: `EMAIL_ALLOWLIST` (binding refused: `email_allowlist_required_for_non_production`), `SUPABASE_ANON_KEY`, `PROVISIONAL_HOLDS_ENABLED`, `NOTIFICATION_WORKER_ENABLED`, `COI_UPLOAD_ENABLED`; re-entered `CRON_SECRET`, `STRIPE_WEBHOOK_SECRET`, `CHECKOUT_ENABLED`.
4. Deployment Protection (Vercel Authentication) stays **on**; a Protection-Bypass-for-Automation secret lets the test script and the Stripe webhook URL through.

Operator probe of the final preview build: `env=preview`, `binding_error=null`, `stripe_mode=test`, `email_mode=sink` (allowlist 2), `db_environment_expected=staging`, flags `provisionalHolds=true, checkoutEnabled=true, notificationWorker=true, slotEditing=false, coiUploadEnabled=true` — i.e. David's approved launch configuration. (`brandInviteEnabled=false` in Preview; not needed by the journey.)

**Two things to know about the preview:** (a) `SITE_ORIGIN` is one variable shared by Production and Preview (`https://www.demohubhq.com`), so the same-origin guard on the preview accepts only that origin: a script can drive it (it sends the header), a real browser on the preview URL cannot perform mutations, and the hold's `success_url` points at the production domain. The journey is therefore HTTP-driven, with Playwright used only for Stripe's hosted page. (b) Vercel cron does not run on previews, so the workers were invoked with the Preview cron secret.

## 4. Deployed-preview hold journey — 104 passed, 0 failed

Script, console log, screenshot and ids: `demohub-docs/evidence/preview-journey/` (commit `fb7721b`). Every product step is an HTTPS request to the deployment; **Stripe delivers its own webhooks to the deployment**; the test never replays an event except in the replay scenario. Fixtures are created and inspected with the service key on demohub-rebuild-check and removed afterwards.

| Your required case | What ran on the deployment | Result |
|---|---|---|
| Authorization | book without COI → `held` + 24 h window → `/api/checkout` → real `cs_test_` → hosted page → PI `capture_method=manual`, `requires_capture`, $0 received → **Stripe's delivery** moves the group to `authorized` (×5 holds) | pass |
| Manual capture | retailer confirm **before** COI approval refused (`coi_pending`), nothing captured; approval alone captures nothing; confirm after approval → PI `succeeded` $5.00, ledger `paid`, booking `confirmed`, fulfilment generation 2 done, exactly one demo, no case | pass |
| Automatic capture | auto-confirm retailer: owner approval answers `captured_holds=1`, per-hold `outcome=captured, applied=true`, no case; PI `succeeded` | pass |
| Release | retailer declines a held booking → PI `canceled`, $0; group `auth_canceled`, booking `declined`, no refund rows, no case | pass |
| Expiry | `held_expires_at` moved 1 min into the past (disclosed manipulation) → sweep → PI `canceled`, booking `expired`, no case | pass — see §5 |
| Worker overlap | two simultaneous `refund-worker` invocations (fulfilment), two simultaneous `provisional-sweep`, two simultaneous `notification-worker` ticks | pass — see §5 for the sweep |
| Replay | the real `checkout.session.completed`, correctly signed, re-POSTed → 200, ledger/booking/outbox/cases byte-identical, one inbox row; wrong signature → 400 | pass |
| Repaired error reporting | authorization cancelled out-of-band at Stripe, then retailer confirm → **502 `capture_failed`, `captured:false`, `stage:verify`, `pi_status:canceled`, “nothing was charged”** — true; ledger converges to `auth_canceled`, booking not confirmed | pass |
| Mail containment | binding in sink mode; frozen message addressed to the brand; send path redirects to the allowlist with a `[SINK]` banner | **pass at the binding/outbox level; inbox arrival NOT independently confirmed** — I could not find the redirected mails through David's Gmail connector and he has not yet confirmed them. Provider accepted the sends (fulfilments completed, deliveries `accepted`). |
| Brand profile / agreement / COI smoke | `profile-update`, `data`, anonymous refusal, `agreement-list`, booking page served with the agreement modal, `upload-coi` → pending, owner queue, owner approve | pass |
| Frozen message reused after context change (F-1) | after the notice was sent: contact renamed, completed outbox row reset to pending (disclosed manipulation simulating a lost completion record, same generation), two overlapping workers → completes; stored message **byte-identical** (old name, same `frozen_at`), no runaway attempts, no case | pass |
| Also | Vercel auth wall (401 without bypass), CSRF guard refuses a foreign origin, cron endpoints 401 without the secret, `/gussmarket` 307, succeeded heartbeats for the three workers, `projection_anomalies` / `snapshot_drift` / `offering_anomalies(invariant)` / `schedule_mismatches` = 0, no open case from any journey booking | pass |

## 5. One observation — overlapping `provisional-sweep`

Two sweeps started in the same instant on the same expired hold: **both reached Stripe's cancel call.** Stripe's own PaymentIntent lock refused one (“There is currently another in-progress request using this Stripe PaymentIntent”); that invocation answered **500 `partial_failure`, `released:0, errors:1`**; the other answered 200 `released:1`. State converged correctly — one cancel, booking `expired`, group `auth_canceled`, **no reconciliation case** — and the next sweep was clean (200, nothing to do, no errors). Reproduced on two consecutive runs.
Assessment: money-safe and self-healing; the cost is a failed heartbeat for the losing invocation. Production cron does not normally overlap (15-minute schedule, short invocations). This matches the documented design decision that no separate resolution lease exists because the ledger RPCs serialise on the payment group. **I changed nothing** (candidate frozen). Your call whether this is acceptable for the pilot or needs a follow-up.

## 6. Production baseline (read-only, 2026-09-18T10:59Z)

Taken by me through PostgREST GET/HEAD and one read-only RPC with the production service key David provided earlier for the venue work; no write verb exists in the script. File: `evidence/cutover/2026-09-18-production-baseline.json`.

- Identity: `production / dkgjvsstbgnhcfboqqnd`. Site: build `32e1418`, status `operational`, cron ok.
- **Section A — every row 0:** open checkout attempts, unsettled groups, authorized holds, held bookings, pending-payment bookings, pending/failed fulfilments, fulfilment claims (any), refund requests/operations in progress, events `processing`, open reconciliation cases.
- Data: **0 bookings, 0 brands, 0 payment groups, 0 fulfilment rows**; 3 retailers, 10 venues, 33 store contacts, 10 demos. Real data (Gus's venues and contacts) — **never reset or wiped**, as you instructed.
- Section B: last heartbeats `refund-worker` / `provisional-sweep` succeeded (normal 15-min cadence — containment not yet entered); last Stripe event 2026-09-05, `completed`. B2: 0 non-completed events in 3 days.
- **Not yet taken (needs SQL, operator-run in the window):** section C ledger (`0060…0072` expected), `pg_stat_activity`, the Stripe dashboard outstanding-deliveries check, and the T0/T1 timestamps.

## 7. Proposed cutover procedure (runbook v5.1, unchanged in substance)

Operator: David. Flags at the end: `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true`, `NOTIFICATION_WORKER_ENABLED=true`, `SLOT_EDITING_ENABLED` unset.

1. **Contain (§2):** Vercel **Production** `CHECKOUT_ENABLED=false`, `PROVISIONAL_HOLDS_ENABLED=false` → redeploy the old build → confirm `/api/checkout` 503; operator freeze (David is the only operator; Gus told in writing); **Disable Cron Jobs** = **T0**; record the effective max function duration; wait it out; **T1**.
2. **Gate (§3):** `00-preflight.sql` (one read-only SELECT: identity, ledger `0060…0072`, every stop-condition, last heartbeat, app DB activity) + the Stripe dashboard deliveries check. Any non-zero stop row → stop, per the runbook table.
3. **Migrate (§4.1):** ten pastes, `01-0074.sql` … `10-0083.sql` (§8), one at a time; I read each result before the next is loaded.
4. **Deploy (§4.2):** on David's “deploy”, fast-forward `main` to the candidate and push; confirm `/api/version`; `/gussmarket` smoke; checkout still 503.
5. **Verify (§6.1):** `11-final-verify.sql` (ledger `0074…0083`, five audits, no pending work, no open cases, venue/contact counts unchanged).
6. **Restore (§6.2):** `NOTIFICATION_WORKER_ENABLED=true` → redeploy → cron back on → one succeeded heartbeat each for `refund-worker`, `provisional-sweep`, `notification-worker` on the new build → then `CHECKOUT_ENABLED=true`, `PROVISIONAL_HOLDS_ENABLED=true` → redeploy → booking page offers checkout → lift the freeze.
7. No production payment/refund smoke in this procedure (separately authorized, as you required).
8. On any unexpected SQL error: your v5.1 rule — keep containment, classify, resolve, all original post-conditions must pass, forward-repair only, never re-paste 0074 on an assumption.

## 8. The operator paste kit (new — please review)

Why: David runs SQL by pasting into the dashboard; separate “paste migration / paste verify / paste ledger insert” steps triple the chances of an operator slip. Each kit file is **one paste**:

```
[1] guard        DO block: RAISE unless get_deployment_identity().environment = 'production'
                 AND max(supabase_migrations.schema_migrations.version) = '<exact predecessor>'
[2] migration    the file's content, byte-for-byte (sha256 in MANIFEST.json), nothing edited
[3] record+show  INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES (…);
                 SELECT 'OK 00NN RECORDED (n/10)', ledger tail, <that version's runbook verify values>;
```

Properties:
- **The ledger row is the last write of the paste**, so it is reached only if every statement of the migration succeeded — including the file's own post-condition blocks. A simple-query batch stops at the first error (your accepted rehearsal: paste A stopped at the raise; paste B rolled back). This implements your correction — a row is never recorded on the strength of the short verify column; the verify values are *displayed* as a diagnostic next to the OK line.
- For `0078–0083` (no explicit transaction) the whole paste is one implicit transaction: any failure rolls back migration **and** ledger row together.
- For `0074–0077` (own `COMMIT`): if a post-condition after the `COMMIT` raises, the DDL is committed and **no ledger row is written** — the exact state your rule handles (contain, inspect, classify, forward-repair). The guard then also **refuses the next paste**, because the predecessor version is missing, so the operator cannot continue past an unresolved failure; and it refuses a re-paste of the same file only once it has been recorded — a blind re-paste of an unrecorded 0074 is prevented by procedure (I hold the clipboard and will not reload it), not by the guard. If you want that enforced in SQL too, the 0074 guard can additionally refuse when `bookings.start_at` already exists.
- The guard makes out-of-order, duplicate and wrong-project pastes fail before anything runs. Tested: on demohub-rebuild-check it raises `CUTOVER GUARD: this database identifies as staging, not production — STOP`.
- All ten display SELECTs plus `00-preflight.sql` and `11-final-verify.sql` were executed on the fully migrated test project inside a rolled-back transaction: they parse and return the expected values (`stale`, `(absent)`, `0`, trigger count 1, …).
- **Not rehearsed end-to-end in the dashboard:** the kit wrapper itself (guard + tail around a real migration, from 0072). The migration sequence it wraps *was* rehearsed (CI upgrade rehearsal through 0083, upgraded == clean; your accepted SQL-editor rehearsal). A kit rehearsal would cost one more reset → 10 pastes → restore cycle on demohub-rebuild-check with David's approvals.

## 9. Questions for your second opinion

1. **Kit design (§8):** acceptable as the execution form of runbook §4.1? Is recording the ledger row in the same paste, as the last statement, consistent with your “all original post-conditions must pass before recording” rule? Do you want the extra SQL-level re-paste refusal for 0074–0077?
2. **Kit rehearsal:** required before production, or is the wrapped sequence's existing rehearsal evidence sufficient given production holds 0 bookings / 0 payment rows?
3. **Which commit to deploy:** `67613b5` (the reviewed SHA; `main` fast-forwards to it) — or the branch head `84e8fc4` (identical tree, seven empty commits)? I propose `67613b5`.
4. **Sweep overlap (§5):** acceptable for the pilot as observed, or a required follow-up before/after launch?
5. **Mail containment:** is binding-level + outbox evidence enough, or do you require confirmed inbox arrival of a `[SINK]` message before the window?
6. **Shared `SITE_ORIGIN` on Preview (§3):** acceptable that the preview journey was HTTP-driven rather than browser-driven for mutations? (The three DOM suites and the Stripe-hosted-page step cover browser behaviour separately.)
7. **Baseline by REST:** acceptable as the “before” record, with sections C / `pg_stat_activity` / T0–T1 / Stripe deliveries taken by the operator inside the window?
8. **Containment given an empty production:** any step of §2 you would relax or strengthen for a database with no bookings, brands or payment rows?
9. Anything else you want in place before David opens the window.

## 10. Where everything is

- Runbook v5.1: `demohub-docs/docs/release-b-cutover-runbook.md` (export `Documents/Codex/Demohub-Release-B-Cutover-Runbook-v5.1.md`).
- Preview journey script + evidence: `demohub-docs/evidence/preview-journey/`.
- Production baseline + kit builder + manifest: `demohub-docs/evidence/cutover/`. Kit files: `Documents/Codex/cutover-kit/` (`00-preflight.sql`, `01-0074.sql` … `10-0083.sql`, `11-final-verify.sql`, `MANIFEST.json`).
- CI: release gates [35212989665](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35212989665) (on `67613b5`), post-rotation validation [35291726833](https://github.com/grassrootsmarketing/gus-community-market-portal/actions/runs/35291726833).

**Production is unchanged: `main` = `32e1418`, ledger `0060–0072`, no write, migration, deploy, flag change, payment or refund in this round.**
