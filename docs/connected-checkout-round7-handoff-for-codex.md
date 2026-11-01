# Connected checkout round 7: handoff for Codex review

Branch `feat/connected-checkout-rehearsal`, head `7981bb9` (round 7 code `3b8fcc0`, evidence `a7e5261`, `009e36c`, `adf7a31`, `ee6f135`; `7981bb9` is only the Claude Code permissions file). Not merged, not deployed to Production. Stripe TEST mode only throughout. Migrations 0116 to 0120 are applied to demohub-rebuild-check (`tileejdviuvijumjeplv`) only; nothing in this branch is on demohub-prod. `npm run check` and `npm test` are green on the head as of 2026-11-01.

This round answers the two "next actions" from the Codex review of `7daf7ce` (round 6).

## 1. Next action 2: the expired-session retry (code, `3b8fcc0`)

The defect: `api/checkout.js` created the Checkout Session BEFORE the ledger said whether the group could have a new attempt, under an idempotency key derived from an attempt count the handler read (falling back to zero when that read failed). A retry while an attempt was open created an unregistered session on Stripe and was only then refused; the next retry got that same session back from Stripe's idempotent replay and registered it as open without checking it could still be paid, so after it expired the brand was handed a dead link.

The fix (`supabase/migrations/0120_payment_attempt_reservations.sql`, forward-only):
- `payment_attempts` gains a `reserved` status, `generation` and `reserved_at`; partial unique index `payment_attempts_one_live`: at most one `open` or `reserved` attempt per group (alongside the 0032 one-open index).
- `reserve_payment_attempt(group, hash, schema)`, under the group row lock: returns the live attempt that already exists (open: the handler verifies the session's current state on Stripe and reuses, expires or refuses it; reserved: the same reservation, so simultaneous retries share one key) or inserts a new `reserved` attempt with the immutable request hash and the next generation.
- The handler creates the session under a key that names the reservation (stable across retries, never random), verifies the returned session is open and unpaid before registering or returning it, and binds it through `register_payment_attempt` (five-argument signature unchanged for the ledger tests and fixtures).
- An unusable session (expired or complete on replay) or one that fails amount reconciliation is recorded as the reservation's terminal outcome (`fail_payment_attempt`, with session id and reason) before advancing to a new generation.
- A failed ledger read fails the checkout closed; no "sequence zero" fallback remains.
- Tests: `tests/attempt_reservation.test.mjs` (new, in `test:routes`) with a provider-like session spy in `tests/_route.mjs`; `route_flows`, `claim_reuse`, `group_ids_fairness` adjusted. Paste kit and rehearsal: `tools/make-0120-paste.mjs`, `tools/rehearse-0116-0120-paste.mjs`; catalog evidence `tests/evidence/catalog-*-2026-10-31-r7.json`.

## 2. Live case RT on real Stripe test sessions (`a7e5261`)

`tests/evidence/connected-checkout-rehearsal-2026-10-31-round7.json`, 24 checks as recorded by the run, hosted-form screenshots `...-RT1/RT2/RT3-form.png`. What it shows for RT1:
- Retry while the first session is open: 409 `attempt_in_progress` from the ledger BEFORE any session is created; zero session POSTs on the retry; Stripe shows only the one open session.
- After the session expired (`checkout.session.expired` delivered, webhook 200), the retry created a fresh session under a NEW reservation (generation 2); no orphan session.
- One charge, one transfer, one application fee; checkout after payment refused (409).
- Observation: `charge.transfer` and `charge.application_fee` were populated about 2.3 s after the session read paid (relevant to the group id fill).

## 3. Next action 1: deployed transport proof on Preview (`009e36c`, `adf7a31`, `ee6f135`)

`tools/verify-preview-transport.mjs` against Vercel Preview `demohub-n7yiqhak6-grms-projects-0d18c653.vercel.app` (commit `a7e5261`), bound to demohub-rebuild-check, its own test webhook endpoint `we_1UWZDNA6b3orPg0ToTQaJm2v`. The runner refuses anything that is not that project, an `sk_test_` key and a `*.vercel.app` host. Final evidence `tests/evidence/preview-transport-2026-10-31-r7.json` (20 checks as recorded by the run); earlier aborted and partial attempts are kept beside it, named as such.
- version: the deployment's operator view reports the expected commit, env preview and the rebuild-check binding.
- consumers: the only enabled test endpoint is the new one; the old preview endpoint disabled (`stripe-test-webhook-preview-disabled-2026-10-31.json`).
- keeps-all: booked and checked out through the DEPLOYED routes, paid for real, Stripe delivered `checkout.session.completed` to the deployed endpoint; inbox row written by the deployment, ledger paid. No in-process replay.
- connected: a connected session (created by the local harness, since Preview has no intake flag), paid, delivered; transfer and fee ids landed on the group.
- signature: unsigned and wrongly signed POSTs both 400.
- worker / worker_group_ids: the deployed `/api/refund-worker` invoked by the runner with the Preview cron secret (recorded as an authenticated deployed-worker test, not as cron) settled a connected refund on real objects, and recovered the group ids for the zero-fee case.
- scheduler: production cron read from `vercel.json` only; Preview has no scheduler.
- Stripe dashboard (`ee6f135`): all four deliveries 200 OK, source Automatic; endpoint 18 delivered, 0 failed that week.

## 4. Not proven yet (be explicit about these)
1. The `after-resend` phase: duplicate delivery of `evt_1UWZQ0A6b3orPg0TBMUuHfkW` via dashboard Resend, then `--after-resend` (inbox answers duplicate, ledger and fulfilment unchanged). Waiting on a manual dashboard click.
2. The connected session on Preview was created by the local harness, not by the deployed checkout route, because the intake flag is off on Preview.
3. The worker was invoked by hand with the cron secret; the Vercel scheduler itself was not exercised.
4. Nothing on demohub-prod; 0116 to 0120 have paste kits but have not been pasted.

## 5. What I would like Codex to look at hardest
1. `reserve_payment_attempt` and the handler's verify-then-register order in `api/checkout.js`: any path where a session is returned to the brand without a matching live reservation, or where two generations can be live at once.
2. Crash points: handler dies after Stripe created the session but before `register_payment_attempt`; is the next retry's replay always detected and either reused (open, unpaid) or terminated cleanly?
3. A `reserved` attempt that never gets a session (handler crash before the Stripe call): does it block the group forever, and what releases it?
4. Whether the ~2.3 s lag on `charge.transfer` / `application_fee` is fully covered by the worker's group id recovery.
5. Whether items 2 and 3 in section 4 are acceptable gaps for this rehearsal or need a flag-on Preview run before Production.
6. The next round: what should round 8 be, and is anything here blocking the Production paste of 0116 to 0120?
