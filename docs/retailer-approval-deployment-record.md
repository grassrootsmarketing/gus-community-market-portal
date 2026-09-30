# Demohub retailer approval: deployment record (2026-09-30)

Short record per Codex's acceptance ("return a short deployment record, not another broad audit packet"). Everything here is **observed** unless marked otherwise.

## What was deployed

- Production `main` = **`4e378ec`**, merge of `feat/retailer-approval` @ `80e9bc9` (which includes `feat/owner-visibility-v2` @ `255c925`) onto the previous production `a01a118`. Pushed 2026-09-30 09:42 UTC; `GET https://www.demohubhq.com/api/version` → `{"ok":true,"build":"4e378ec"}` at 09:42:58 UTC (was `a01a118` sixteen seconds earlier).
- Flags at deploy: `PUBLIC_RETAILER_SIGNUP_ENABLED` **not set** in Production (checked with `vercel env ls production` before merging); `ALLOW_PUBLIC_SIGNUP` not set. No env change was made. **Public sign-up is closed.**
- Migrations on demohub-prod, both applied by David in the SQL editor before the deploy: 0086 (result `0083,0084,0086`), 0087 via the guarded kit (result `0083,0084,0086,0087`, service_role execute **true**, anon execute **false**, authenticated execute **false**, anon table read **false**, RLS **true**). 0085 (booking codes) is **not** applied and stays out of this release.

## Preflight (Codex item 2)

- Inventory read by David on demohub-prod: **three rows only**, `gus`, `harvest-lane-demo`, `__owner__` (David confirmed in chat, 2026-09-30).
- Targeted change: `slug = 'gus'`, pending → **approved** at `2026-09-30 03:31:51 UTC`, `verified_by david@demohubhq.com`. `harvest-lane-demo` (demo tenant) and `__owner__` (system row) left pending, as intended.

## Production smoke (read-only; nothing created, charged or deleted)

| Check | Observed |
|---|---|
| Build | `4e378ec` |
| Gus public-data | `accepting_bookings: true`; no `verification_status` field published |
| Demo tenant public-data | `accepting_bookings: false` |
| Sign-up route with flag off | 403 `public_signup_disabled` with the invite-only message |
| Old sign-up route | 403 `signups_closed` (unchanged, closed) |
| Sign-up page | serves the code that shows the server's message (not the raw code) |
| Booking page | serves the not-taking-bookings notice code |
| Owner page | serves the approval UI (Resend live notice present) |
| `/api/book` without a session | 401 (identity is checked before the gate, as designed) |

Not observed by Claude (operator items for David): owner sign-in on production; the Retailers tab showing Gus without a pending pill and `harvest-lane-demo` as "Pending approval · demo" and absent from the Overview approval banner. Nothing in this deploy touched authentication or cookies.

Pending-store refusal on every booking route, approval races, budget races, failed-email and resend behaviour were proven on demohub-rebuild-check (`retailer_gate.smoke` 10/10, `retailer_approval` 33/33) and were **not** exercised in production, per Codex item 4.

## Fallback

`fallback/retailer-approval-gate-only` @ `c624bb6`: a forward commit on `80e9bc9` that withdraws the sign-up, owner-approval and notice additions while keeping the go-live gate, `accepting_bookings`, the page notice and migrations 0086/0087. If ever used: merge it into `main` (it descends from the deployed release), with both sign-up flags still off. Not used.

## Next (separate, not done)

Opening public sign-up requires David's explicit instruction: set `PUBLIC_RETAILER_SIGNUP_ENABLED=true` in Vercel **Production** (Preview optional) and redeploy, then verify the flag passed (`{action:'request', email:'not-an-email'}` → 400 `valid email required`). `ALLOW_PUBLIC_SIGNUP` stays unset.
