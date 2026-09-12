# Demohub — Production hotfixes since the Release B candidate + test-data wipe (handoff for Codex)

**From:** Claude Code · **To:** Codex · **Date:** 2026-09-12
**Context:** Release B round 3 (C1–C4) is closed on candidate `7d6cccd` (packet + round-3 handoff already sent; verify #135 fully green). While that awaits your verdict, David asked for four small production changes and a data wipe. This note records them so nothing reaches you as a surprise, and states how they will be folded into the Release B branch.

## 1. Production state

| Item | Value |
|---|---|
| Production build | **`53961d7`** (main), deployed 2026-09-12 07:10Z; `/api/version` confirms; public status operational |
| Schema | unchanged: ledger `0060`–`0072`; no migration, no env-flag change in any of these |
| Holds | `PROVISIONAL_HOLDS_ENABLED=true` remains (David's decision; your pause recommendation was put to him and he chose to leave it on). No production bookings or holds have been placed since. |
| Release B branch | still `7d6cccd`; **not** touched by these hotfixes (deliberately — your "do not keep making unreviewed post-freeze merges" instruction) |

## 2. The four hotfixes (each cut from `main`, tests green, code-only)

| Commit | What | Why | Verification |
|---|---|---|---|
| `9fa0854` | Signup category persisted once (rides the challenge payload, applied at redeem, blank-only) and a first booking saves its category to the profile; the booking form then pre-fills/hides "What are you demoing?" | Brands were asked the same question on every booking; the signup value was only saved by a page-side follow-up on one of two surfaces | `tests/brand_signup` 21/21; route suite 192/192 on a local merge with the B branch |
| `8df8828` | Owner alert: `api/_owner-alerts.js`, called from the fulfilment outbox worker after the brand's own notice succeeds — one email to david@demohubhq.com when a brand **actually** books (paid, or hold authorized); nothing at `/api/book` time; a captured hold is not announced twice; best-effort, never throws into the worker | David asked to hear about real bookings only | `tests/owner_alert` (offline, in `npm test`), mail containment guard, static checks |
| `84a6548` | Your preview review (2026-09-11): hold copy follows the retailer's **current** `auto_confirm_bookings` (read at send time; manual-confirm = approve COI **and** confirm; auto-confirm = attempted capture, never promised; unknown = neutral); deadline = the booking's own `held_expires_at` with zone; occurrence line shows date, start–end, zone abbreviation for that date and length (snapshot when present, else retailer zone + `settings.demo_duration` labelled as the setting, else "length not recorded"); preview generator `tools/render-owner-alert-preview.mjs` escapes its header lines | Return packet `Demohub-Owner-Alert-Preview-Return-2026-09-11.md` already sent | `tests/owner_alert` 23/23 |
| `53961d7` | Agreement modal: both policies in one bounded scroll box (240px / 38vh) with a "Scroll to the end" control; the agree checkbox is disabled until the end is reached (or at once when the text fits); the accept guard refuses a signature before that; jump is instant (works with reduced motion / background tabs). Signature, Terms link and the server-side agreement record unchanged | The full policy text rendered inline and made the modal several screens tall on a phone | Real Chromium at 375×812 and 1280×900 with Gus's policy text: locked → guard message → unlocked; page scripts parse; no-undef clean |

None of these touches payments, capture/release, refund policy, COI policy, confirmation mode, RLS, auth or webhooks.

## 3. Test-data wipe (production)

David ran the reviewed script `Demohub-Prod-Wipe-Test-Brands-2026-09-12.sql` in the SQL editor for demohub-prod: one transaction, dependency order, removing the two test brands (Launch Proof Foods — the Sept 3 launch proof with its cancelled/refunded booking, demo, payment group and refund rows; Test Name — the Sept 11 UX test) and every row they owned. Verified afterwards (read-only, 07:26Z): brands 0, bookings 0, payment_groups 0, demos with a brand 0, Gus venues 5 (unchanged), demo-tenant sample demos 10 (unchanged, `brand_id` NULL). Not touched on purpose: the two COI PDFs in the `coi-docs` bucket (harmless orphans) and the Sept 3 $1 charge/refund in Stripe (its own record). Production is now a clean first-brand state; the "0 future active reservations" inventory statement in the Release B packet is true again.

## 4. How these fold into Release B (when you accept)

1. Merge `main` (`53961d7`) into `feature/release-b-slots-blackouts` (`7d6cccd`). Expected conflicts, both trivial: `api/book.js` (select lists: keep `name,timezone` on retailers and `name,availability` on venues) and `api/_fulfillment.js` (the owner-alert hook lands after the hold-notice and promotion-notice lines in the 0078 worker).
2. Adjust the mail-count assertions in `tests/fulfillment_lifecycle.test.mjs` and the Stripe journey: every paid / hold fulfilment now sends one extra (owner) mail.
3. Re-run the full battery and the full CI gates (clean build + two consecutive staging passes) on the merged head; that head becomes the deployable candidate and the packet is updated with it.
4. Then the production sequence as written: migrations 0074–0079 with ledger rows (0073 omitted), merge to `main`, Production env flags, redeploy, audits.

## 5. Asks

1. Acknowledge the four hotfixes as in-scope operator changes (or object to any of them).
2. Your Release B verdict on `7d6cccd` stands as requested; say whether you want the merged head re-reviewed before or after the gates re-run.
