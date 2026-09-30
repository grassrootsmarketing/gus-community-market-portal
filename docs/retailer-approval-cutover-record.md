# Demohub retailer approval: cutover record (started 2026-09-30)

Living record for the release Codex conditionally accepted on 2026-09-30 ("RA response acceptance and cutover instructions"). Filled in as each step is observed. Anything not marked **observed** has not happened.

## Artifacts

| Item | Value |
|---|---|
| Release branch / SHA | `feat/retailer-approval` @ **`80e9bc9`** (0a4ec82 + 0087 migration + gate smoke + serial-order race assertion) |
| Base | `feat/owner-visibility-v2` @ `255c925` (accepted), on `main` @ `a01a118` (production today) |
| Fallback (executable) | `fallback/retailer-approval-gate-only` @ **`c624bb6`**: forward commit on 80e9bc9 restoring the six non-gate files to their 255c925 versions; keeps `api/_retailer-live.js`, the gate checks, `accepting_bookings`, the page notice, migrations 0086/0087. Verified on that tree: `retailer_gate.smoke` 10/10, `route_flows` 191/191, `owner_directory.smoke` 57/57, `npm run check`. Use only with `PUBLIC_RETAILER_SIGNUP_ENABLED` and `ALLOW_PUBLIC_SIGNUP` OFF (the restored sign-up route has the old limiter). Sibling `hotfix/approval-gate-only` @ 9e64ad5 is superseded by this forward commit and is not the fallback. |
| Migration 0086 kit | Applied to demohub-prod by David on 2026-09-30 from the unmodified migration body plus its ledger insert, **before** Codex's acceptance arrived. Observed result line: `0083,0084,0086`. Not a guarded kit; recorded as such. |
| Migration 0087 kit | `Documents/Codex/cutover-kit/0087-signup-budgets-grants-paste.sql`, sha256 `237762974d013c7be1795ce9ce986631248f6b2c83f6bc5fa9f0f8835635d51a` (migration file sha256 `796a27d80c5395ad65879349e0b2ac69a696ba39fb6a9e02b59cdaf8f757a2db`), `MANIFEST-0087.json`. One transaction: identity guard (production), ledger guard (`0083,0084,0086` exactly), 0086 objects present, migration body, privilege assertions, ledger insert; then a read-only verify select. Rehearsed on demohub-rebuild-check: guard refused ("identifies as staging, not production"), as designed; the migration body was applied there separately from the migration file (ledger tail there `0083,0084,0085,0086,0087`). Before 0087 on the test project, `has_function_privilege('service_role', ..., 'EXECUTE')` was already true via default privileges; 0087 makes it explicit and asserted. |
| 0085 (booking codes) kit | Regenerated: guard now expects the ledger from 0083 to be exactly `0083,0084,0086,0087`; migration sha unchanged (`f20246ca…`); rehearsed refusal on the test project. 0085 stays out of this release. |
| Tests (demohub-rebuild-check) | `retailer_approval` 33/33 (20-way budget and approval races), `retailer_gate.smoke` 10/10, `route_flows` 191/191, `owner_directory.smoke` 57/57, `launch_flags` 70/70, `session_transport` 76/76, `status_page` 43/43, `binding` 59/59, `store_contact_notifications` 117/117; `npm run check` 86 migrations |
| Preview | `demohub-signup-preview-grms-projects-0d18c653.vercel.app` runs 0a4ec82 with the flag on (deployment-scoped env), demohub-rebuild-check |

## Preflight (Codex item 2)

- **Observed 2026-09-30 03:31 UTC**: David ran the inventory and the targeted approval on demohub-prod. Result row: `gus | approved | 2026-09-30 03:31:51.619158+00`. Target: `slug = 'gus'` only; before: pending (default); after: approved, `verified_by david@demohubhq.com`, note "Pilot retailer, approved before the go-live gate shipped".
- **Observed 2026-09-30**: David confirmed the inventory showed only `gus`, `harvest-lane-demo` and `__owner__`.
- **Observed 2026-09-30 (David, demohub-prod SQL editor)**: 0087 paste ran; verify row: ledger `0083,0084,0086,0087`, service_role can execute **true**, anon **false**, authenticated **false**, anon can read table **false**, RLS **true**.

## Deploy (Codex item "on David's authorization")

- Flags: `PUBLIC_RETAILER_SIGNUP_ENABLED` unset (off) in Production and Preview; `ALLOW_PUBLIC_SIGNUP` unset (off). No change at deploy time.
- Action on "deploy": merge `feat/retailer-approval` (80e9bc9) into `main`, push. Production build follows.
- **Observed 2026-09-30 09:42 UTC**: merged as `4e378ec`, pushed; build live at 09:42:58 UTC. Read-only smoke results are in docs/retailer-approval-deployment-record.md.

## Production smoke (read-only / operator, no fixtures, no charges)

To be recorded with observations after deploy:
1. `GET /api/version` build equals the merged SHA.
2. Owner sign-in works (David).
3. `POST /api/find-retailer {action: 'public-data', slug: 'gus'}` → `accepting_bookings: true`; `/r/gus` shows locations.
4. Sign-up page shows the invite-only message (flag off); `POST /api/retailer-signup {action:'request'}` → 403 `public_signup_disabled`.
5. Ledger tail `0083,0084,0086,0087` and the 0087 privilege select all as expected (SQL editor, read-only).
6. Owner panel Retailers tab: Gus shows no pending pill; `harvest-lane-demo` shows "Pending approval" with a demo pill and is not in the Overview approval banner.
7. Existing money flows observed only through normal use; nothing charged, refunded or deleted for evidence.
8. Pending-store behaviour is proven on demohub-rebuild-check (retailer_gate.smoke, retailer_approval), not by creating production fixtures.

## Opening sign-up (separate, David's explicit instruction, after Codex accepts the RA response)

- Set `PUBLIC_RETAILER_SIGNUP_ENABLED=true` in Vercel **Production** (Preview optional), redeploy. `ALLOW_PUBLIC_SIGNUP` stays unset.
- Verify: `/api/retailer-signup {action:'request', email:'not-an-email'}` → 400 `valid email required` (the flag passed, validation reached). If David authorises one controlled sign-up from an operator inbox: it must arrive pending, its page must say not taking bookings, and it is left in place (or cleaned up only after a separate review).
- **Not yet performed.**
