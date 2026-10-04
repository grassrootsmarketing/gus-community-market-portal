# Demohub deployment record: sign-in reliability (code-only groups) and owner Notifications panel (2026-10-04)

**Deployed:** `main` @ **`2dbc2a6`** = production `ae22e3f` + `fix/signin-visibility` `fd3d886` (S-1/S-3/S-5 + maintenance gate code, gate off) + `fix/brand-retailers-tab` `94d5beb` (S-4) + `feat/owner-notifications-panel` `7abd36c` (N-1 with C-3/C-4). **Not deployed:** `fix/signin-codes` `4a1378e` (S-2, migration 0089), held for Codex's verdict on closure revision 2 and the gated cutover. Codex's closure review (2026-10-03) allowed the code-only groups to be released separately with their own tested artifact.

**Artifact test, on `2dbc2a6` before the push** (demohub-rebuild-check, mail intercepted): `npm run check` 4/4; `npm test` exit 0; signin_config 123, brand_signup 21, retailer_approval 33, brand_retailers_tab 27, owner_notifications 92, route_flows 191, launch_flags 70, status_page 43, session_transport 76, all 0 failed. (The combined candidate `8271e93`, which additionally carries S-2, had the full battery green earlier the same day.)

**Schema:** no change. Production remains on the pre-0089 schema; this artifact uses the pre-0089 sign-in paths (old issuer, old `redeem_brand_signup`), which the compatibility matrix showed working end to end on that schema. `SIGNIN_MAINTENANCE_ENABLED` is not set in Production (gate off).

**Push:** 2026-10-04 ~00:00 UTC. Vercel production build Ready in 15 s. `www.demohubhq.com/api/version` reports build `2dbc2a6` (the apex `demohubhq.com` 308-redirects to `www`).

**Read-only smoke on production, 00:02 UTC:**
- `/api/find-retailer action=status`: operational; db, cron (refund-worker, provisional-sweep, notification-worker, daily) and errors ok; **`signin.ok: true`** (pepper and mail key configured; gate off).
- Gus `public-data`: `accepting_bookings: true`.
- `/owner` serves the Notifications tab; `/brand/dashboard` carries the Retailers-tab merge; `/brand/signin` carries "Codes expire at the time stated in the email."
- Retailer sign-up request: 403 `public_signup_disabled` (sign-up stays closed, as before).
- No production data was written by the smoke.

**What is now live for the pilot:** the owner panel's Notifications tab (read-only: scheduled, overdue, needs-attention and provider-accepted emails per store, worker health, per-booking detail with exact counts); the brand dashboard's Retailers tab shows a store as soon as a demo is paid or held; sign-in configuration failures answer a clear 503 instead of a false "code is on its way"; neutral delivery copy; no em dashes in outgoing mail.

**Rollback (code-only):** redeploy `ae22e3f` (plain `git revert` of the three merge commits, or Vercel "promote" the previous production deployment). No schema step is involved for this artifact.

**Next:** Codex verdict on closure revision 2; then the S-2 cutover under the maintenance gate (runbook in the closure packet), beginning with a read-only check of the production migration ledger.
