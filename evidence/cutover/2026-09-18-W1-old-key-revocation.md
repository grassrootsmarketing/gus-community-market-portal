# W1 — old demohub-rebuild-check secret key retired (2026-09-18)

- The exposed key is the `sb_secret_` key named `local_dev` in the project's API-keys page (new-style secret key, not a legacy JWT key; the project's publishable key and the replacement `rotated_2026_09` are separate keys and were not touched). Identified privately by matching the pre-rotation local value to the dashboard's displayed prefix; no key value was printed or logged.
- 2026-09-18T11:29:33Z — before deletion: old key → HTTP 200, new key → HTTP 200 (the gap Codex flagged: adoption without retirement).
- David deleted `local_dev` in the dashboard.
- 2026-09-18T20:47:15Z — after deletion, same read-only request (`GET /rest/v1/retailers?select=id&limit=1`):
  - old key → **HTTP 401** `{"message":"Unregistered API key", …}`
  - new key → **HTTP 200**
- Preview after the deletion: operator probe `binding_error: null` (the binding verifies the deployment identity with the service key), Stripe `test`, email `sink`; public status `db.ok = true`.
- CI integration evidence on the replacement key is unchanged: run 35291726833 (suites ×2, clean build A/B, staging gate pass 1 + 2).
- Two other pre-rotation secret keys existed on the same test project (`github_actions`, `vercel_preview`). They were never exposed; GitHub `STAGING_SB_KEY` and Vercel Preview `SUPABASE_SERVICE_KEY` were both moved to the rotated key on 2026-09-17 (CI and the preview journey passed afterwards). Their deletion is recommended housekeeping; status to be confirmed by David.
- Stripe: the exposed **Grassroots Demos** test key (`acct_1MA5mMJ9aYEf28il`, test mode) remains David's recorded accepted-risk exception. It is absent from every active Demohub binding: local env and Vercel Preview use the Demohub sandbox key (`acct_1TmWjfA6b3orPg0T`, confirmed by `GET /v1/account` on the key in use); CI holds no Stripe secret. Account ownership of production live mode was NOT established from PaymentIntent id patterns alone — David is to confirm it in the Demohub dashboard (live Payments list) before the window.
