# Demohub, owner panel visibility: deploy record + pre-deploy handoff for Codex (2026-09-28)

One document, two parts. Part A records what is now live in production (build `a01a118`) and what was verified after the deploy. Part B is the pre-deploy handoff for the next branch, `feat/owner-overview-calendar` @ `d9e49b6`, which is pushed but **not** deployed; it waits for Codex's review and David's "deploy".

Repo: `grassrootsmarketing/gus-community-market-portal` (Demohub). Production project: demohub-prod (`dkgjvsstbgnhcfboqqnd`). Tests run against demohub-rebuild-check (`tileejdviuvijumjeplv`). No migration, env change or redeploy dependency in either part; both are HTML + one serverless file.

---

## Part A: deployed 2026-09-28 (David's "deploy both"), production `main` = `a01a118`

`a01a118` is the merge of two branches onto the previous production commit `b82ef40`:

| Branch | Head | What it is | Reviewed by Codex? |
|---|---|---|---|
| `fix/calendar-first-bookable` | `7907e31` | Booking page UX fixes (calendar opens on the first bookable month + notice of the store's minimum; COI card follows the certificate's real state; certificate-holder / additional-insured guidance). Five commits: b43fe70, 5c19a6b, bcb114a, 6a59210, 7907e31. | Yes. Codex's UX review of 2026-09-28 raised three corrections (classifier treated approved-but-expired / no-expiry as green; hold-window consequence dropped from the copy; universal certificate claims). All three were fixed in 6a59210 + 7907e31 and documented in `booking-page-ux-fixes-handoff-for-codex.md`. |
| `feat/owner-directory` | `746e3e3` | Owner panel: Retailers tab and Brands tab (read-only mirrors of each retailer's profile / each brand's profile), growth chart no longer stretches its text. Two commits: 08e2b6f, 746e3e3. | **No.** Deployed on David's instruction; this is its first Codex look. Details below. |

Files changed b82ef40 → a01a118: `api/admin-auth.js` (+44), `brand/dashboard/index.html` (+1), `owner/index.html` (+103 / -few), `r/gus/index.html` (+124 / -46), `tests/owner_directory.smoke.mjs` (new, 47 lines).

### A1. Owner directory (746e3e3), what Codex has not seen yet

Three new owner-only actions in `api/admin-auth.js`, all gated by `verifyOwnerSession` (owner session cookie only; a retailer staff session gets 401):

- `owner-retailer-profile {retailer_id}`: the retailer row (explicit field list: identity, billing tier/status/period end, timezone, auto-confirm, cancellation mode/policy/url, demo policy/url, platform_keeps_all, Stripe charges_enabled/account_status, verification status, is_demo, expected_locations, monthly_summary_enabled, allow_support_access), its `settings` (demo_fee, demo_duration, advance_booking_days), venues, internal contacts, retailer admins (email, role, created_at), up to 25 upcoming bookings, up to 25 recent bookings, a brand rollup, plus `booking_url` and `admin_url` built with `link(await bind(), …)`. `capped` flags say when a list hit its limit.
- `owner-list-brands {}`: up to 500 brands (id, company_name, contact_name, email, phone, website, coi_verification_status, default_coi_expires, is_verified, created_at) with booking totals / upcoming count / retailer names aggregated from bookings.
- `owner-brand-profile {brand_id}`: one brand (adds logo_url, default_coi_filename, products, default_categories, needs_electricity), its last 100 bookings with retailer names, and a by-retailer rollup (total, upcoming, paid cents).

Ids are validated as 36-char UUID shape before use and URL-encoded into PostgREST filters. **Never selected**: `password_hash`, `cal_feed_key` / `cal_feed_token`, session ids, tokens, Stripe customer / subscription / account ids. The smoke test sets `password_hash` on its fixture brand and asserts the string never appears in any response.

Owner page (`owner/index.html`): two tabs added to the existing tab controller; rows render through delegated listeners with `data-*` attributes (no inline `onclick` with serialised JSON, the Codex BC-1 lesson from booking codes); all text is HTML-escaped. Growth chart: the SVG viewBox now matches the container's real pixel width, remounted through a `ResizeObserver`, so axis text no longer stretches. `fmtD` parses bare `YYYY-MM-DD` as a local date (a `2027-01-01` expiry rendered as Dec 31 before).

Tests: `tests/owner_directory.smoke.mjs` (real `admin-auth.js` handlers against demohub-rebuild-check): owner-only access for all three actions (anonymous 401, staff 401), brand list shape and counts, brand profile rollup ($35 paid, 1 upcoming), malformed id → 400, retailer profile (settings, venue, links, upcoming, brand rollup), and the sensitive-column regex on every body. 10/10 at 746e3e3.

### A2. Post-deploy verification (observed 2026-09-29 04:34 UTC)

- `GET https://demohubhq.com/api/version` → `{"ok":true,"build":"a01a118"}`.
- `https://www.demohubhq.com/owner` → 200; the served page contains the Retailers / Brands tabs and the chart remount code.
- `https://www.demohubhq.com/r/gus` contains `leadTimeNotice` and `_coiCardState` (the UX fixes are live).
- `/gussmarket` still 307-redirects to the booking page.
- Not observed: a real owner sign-in on production after the deploy (David's session). Nothing in the deploy touched auth, cookies or the owner login flow.

Rollback for Part A: `git revert -m 1 a01a118` on `main` (one merge revert restores b82ef40's content), then push. No data to undo.

### A3. Known, not changed (pre-existing, reported earlier)

The retailers PATCH path accepts any string for `cancellation_mode`. Out of scope for both parts; noted so it is not mistaken for a regression.

---

## Part B: pre-deploy handoff, `feat/owner-overview-calendar` @ `d9e49b6` (one commit off `a01a118`)

### B1. Why

David, 2026-09-28: a brand signed up that day and did not appear anywhere on the owner home screen except under "Brands inactive > 60d". Then: "We really need to create a portal where we can view demo calendars across all retailers from the owner portal even if it just a mirror."

### B2. Change 1: Overview watchlist shows new sign-ups

`api/admin-auth.js`, inside the existing `owner-data` handler:

- The brands query now also selects `coi_verification_status, contact_name, email` (still no hash / token columns).
- `inactive_brands_60d` now requires `created_at < now − 60 days` **and** no demo in 60 days. A brand younger than 60 days cannot be "inactive for 60 days" and is no longer listed there.
- New `watchlist.new_brands_30d` (up to 25, newest first): `{id, name, contact, created_at, coi_status, bookings}` where `coi_status` = `none` when no certificate is on file, else the stored verification status (default `pending`), and `bookings` = count of that brand's bookings.
- New `watchlist.new_retailers_30d` (up to 25, newest first, `__owner__` row excluded): `{id, name, slug, created_at}`.

`owner/index.html`: a fourth watchlist card, "New sign-ups (30d)", listing retailers then brands (with sign-up date, COI status, booking count). The inactive card is relabelled "Brands inactive > 60d (signed up 60+ days ago)".

### B3. Change 2: Calendar tab, every retailer's bookings in one month grid

New owner-only action `owner-calendar {from, to, retailer_id?}` in `api/admin-auth.js`:

- Auth: `verifyOwnerSession` (401 otherwise). Same gate and allowlist entry as the other owner actions.
- Input: `from` / `to` must match `YYYY-MM-DD`, `to ≥ from`, span ≤ 62 days (400 otherwise). `retailer_id`, if present, must be UUID-shaped (400 otherwise) and is URL-encoded into the filter.
- Reads: bookings in range with `status in (pending, confirmed, held, pending_payment, completed)`, selecting only `id, retailer_id, venue_id, brand_id, brand_name, demo_date, demo_time, duration_hours, status, payment_status, product, needs_electricity` (limit 2000, `capped` flag); retailers `id, name, slug, timezone`; venues `id, name, retailer_id`. Cancelled and refunded bookings are not shown (they would only clutter a calendar; the retailer admin still has them).
- Returns: `{ok, from, to, retailers:[{id,name,slug}] (owner row excluded), bookings:[{id, date, time, hours, status, payment_status, brand, product, electricity, retailer_id, retailer, retailer_slug, venue}], capped}`. No contact emails, no amounts, no Stripe ids, no notes.

Owner page: new **Calendar** tab between Overview and Retailers. `renderOwnerCalendar()` draws a month grid (Sun..Sat), prev / next / today buttons, an "All retailers" `<select>` filter, and a counts line ("3 bookings · 1 confirmed, 1 pending, 1 held"). Events are coloured by status (confirmed green, pending amber, held / pending_payment grey, completed dark) and labelled "time · retailer · brand". Clicking an event opens a detail panel (date, time, hours, venue, brand, product, electricity, payment status) with an "open in that retailer's admin" link (`/r/<slug>/admin`). All values are HTML-escaped; events and buttons use delegated listeners with `data-*` attributes. Read-only: there is no write action on this tab.

### B4. Evidence (all observed, 2026-09-28/29 local)

Route level, `tests/owner_directory.smoke.mjs` extended to **16/16** against demohub-rebuild-check (fixture: retailer "Directory Fixture Market" with a venue, a brand created during the run with `password_hash` set and an approved COI, one confirmed booking on 2027-01-15 11:00 AM):

- calendar: the fixture booking appears with retailer, venue and brand names, status `confirmed`, time `11:00 AM`.
- calendar: retailer list returned without the `__owner__` row; sensitive-column regex clean on the whole body.
- calendar: `retailer_id` filter keeps the fixture booking; an unknown retailer id returns zero bookings.
- calendar: 151-day range → 400; `from: 'jan'` → 400; no owner session → 401.
- overview: the brand created during the run is in `new_brands_30d` with `bookings 1`, `coi_status approved`, and is **not** in `inactive_brands_60d`.
- overview: the retailer created during the run is in `new_retailers_30d`.
- The ten earlier assertions (access, brands, retailers) still pass.

Browser (local preview `localhost:4174/owner/`, `window.fetch` stubbed with the API's real response shape, no console errors):

- Watchlist card renders "New sign-ups (30d) · 2 · Retailer Zeta Foods · Sep 28, 2026 · Brand Fresh Brand LLC · Sep 28, 2026 · no COI yet · 0 bookings"; the inactive card shows 0 with "Every brand has recent activity."
- Calendar tab: three stubbed bookings render on the right days with the right colours; a booking whose brand and retailer names contain `<i>` / `<b>` tags renders them as text (no injected elements); clicking an event opens the detail with brand, retailer, payment status and the admin link; "next" advances to the following month and re-queries with that month's `from` / `to`; choosing a retailer in the filter re-queries with `retailer_id` and shows only that retailer's bookings.
- `node --check api/admin-auth.js`, inline-script parse of `owner/index.html`, `npm run check` (undefined identifiers) all clean.

Not done: a committed DOM e2e (Playwright still not installed locally); the browser assertions above are reproducible from the recorded stub script but are not in the repo.

### B5. Review asks

1. Field lists in `owner-calendar` and the extended `owner-data` brands select: anything you would not want the owner panel to receive?
2. Range and id validation on `owner-calendar` (62-day cap, UUID shape, URL-encoding into PostgREST filters).
3. The 60-day / 30-day watchlist semantics (a brand younger than 60 days is never "inactive"; is 30 days the right sign-up window?).
4. Anything in Part A's owner directory (746e3e3) you want changed, since it went live without a review.

### B6. Deploy / rollback

Deploy = merge `feat/owner-overview-calendar` into `main` on David's "deploy" (push to main deploys; production-only builds). No migration, no env change. Rollback = revert `d9e49b6`. The booking-codes branch (`feat/booking-codes`, separate review, migration 0085 still to be pasted on demohub-prod) is unaffected and stays unmerged until Codex clears it.
