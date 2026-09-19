# Demohub — pilot follow-ups after Release B (opened 2026-09-19)

Source: `Demohub-Release-B-Closure-Acceptance-and-Pilot-Followups-2026-09-19.md` (Codex). **Release B is accepted for the closed Gus's MVP pilot.** These are normal-operations tickets, not launch gates. Production writes still need David's authorization; no new Codex handoff is required per item.

| # | Follow-up | Owner | State |
|---|---|---|---|
| A1 | Protected `/api/version` operator view on production: save the **redacted** response (full commit, `binding_error: null`, target/db expectation, project fingerprint, Stripe live mode, real-email mode, flags). The production `CRON_SECRET` is stored as a write-only Vercel secret, so this needs the value from wherever David keeps it — never in chat or a report | David | open |
| A2 | Demohub **live** Stripe dashboard: confirm the existing $1.00 payment and its linked $1.00 refund are terminal (succeeded / refunded); record redacted ids + amounts. **No new charge.** A bank-side credit posting is a separate, later fact | David | open |
| B | Brand dashboard Overview tile says "No COI on file" while a certificate is pending review. Narrow display patch: a "COI status" tile driven by the existing `getBrandStatus(profile)` mapping (none / pending review / current / expiring / expired); focused UI tests; **no** change to approval, capture, expiry or auto-cancel | Claude (branch) → David says "deploy" | open |
| C | Retained smoke fixture `zz-demohub-live-smoke-0919`: deactivate its one $1 venue between supervised smokes with the existing venue-active control; keep the retailer and every financial/booking/refund row; reactivate deliberately for the next authorized smoke. Acceptance: a normal booking at the inactive fixture is refused; history intact; no Gus venue touched | Claude, on David's yes | open |
| D | COI files live in Supabase Storage, which database backups do not cover. Either a protected object-backup + restore procedure (verified with a synthetic file in an isolated location, never by restoring production), or David's explicit limited-pilot re-upload contingency while that is built. Local full-data snapshots stay private, out of git (they include auth/session tables); document access, retention, recovery ownership. Live financial records are no longer disposable | Claude proposes → David decides | open |
| E | Operating risks carried forward (no code change): overlapping sweep loser may answer 500 while state converges — keep errors visible; a parked email does not prove nothing was sent — check provider history before any manual resend, never move money to repair an email; the Grassroots **test** key is an accepted-risk exception, revocation still recommended; Vercel builds are production-only — for a future Preview validation deliberately permit the build and verify its SHA (a cancelled build is not fresh evidence) | David (operator) | standing |

## Pilot operating boundary (Codex)

David owns alerts, COI review (manual — AI auto-check is off) and reconciliation. Watch the first real customer journeys: worker failures, payment uncertainty, parked deliveries, Stripe-vs-application mismatches. **Stop expansion and investigate** on an unauthorized charge, an incorrect refund/allocation, confirmed data exposure, an unresolved payment outcome, or sustained worker failure. Use the containment procedure when warranted; never reset production or delete records to make an audit count look clean.

## For the next incompatible migration (process lessons from this cutover)

1. Take a content snapshot **before the first paste**, not after it.
2. Run the **complete** SQL gate at the actual execution point; repeat it after any delay or intervening activity.
3. Capture every paste's result row verbatim before loading the next one.
