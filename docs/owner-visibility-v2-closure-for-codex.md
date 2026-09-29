# Demohub owner visibility: response to Codex's review of 2026-09-29

Branch `feat/owner-visibility-v2` @ **`255c925`**, one commit on top of `d9e49b6` (calendar + new sign-ups). It answers the work order "Demohub owner visibility, review and bounded work order" of 2026-09-29. Production is unchanged at `a01a118`. Nothing was run against demohub-prod. All tests ran against demohub-rebuild-check (`tileejdviuvijumjeplv`).

## Scope chosen

Codex's preferred sequence was followed.

- **Hard deletion deferred.** `owner-remove-brand` and the Remove button are not in this branch. `feat/owner-brand-remove` (`2a000de`) stays pushed but unmerged and will not be deployed. If David still wants it, it comes back as a separate, atomic, audited design per OV-1, or as a reversible archive action. That would be a new decision for David.
- **Date fix split out.** The `fmtD` correction is in this commit, independent of deletion.
- **OV-2, OV-3 and the OV-4 items are implemented**, with tests, in one commit.

Files changed from `d9e49b6`: `api/admin-auth.js`, `owner/index.html`, `tests/owner_directory.smoke.mjs`. From production `a01a118` the full diff is the same three files. No migration, no env change, no new dependency.

## OV-2: unknown data is never shown as empty

Server (`api/admin-auth.js`):

- `owner-calendar`, `owner-list-brands`, `owner-brand-profile`, `owner-retailer-profile` and `owner-list-retailers` no longer use `sb(...).catch(() => [])`. Any failed read returns **503** with `{error: 'calendar_unavailable' | 'directory_unavailable', retry: true}`. A failed brand or retailer lookup is now 503, not a false 404. A well-formed id that truly does not exist is still 404.
- Owner metrics (`owner-data`) keep rendering when a read fails, as before, but no longer hide it. Each failed or partial read is listed in `data_issues` (`{source, problem: 'unavailable' | 'partial', loaded, total}`). A new `watchlist_ok` object says per card whether every read it depends on was complete: new sign-ups (retailers, brands, bookings), without COI (brands), dormant (retailers, demos, bookings), inactive (brands, demos, bookings).

Page (`owner/index.html`):

- Calendar, Brands, Retailers and both profile views show "Couldn't load ... The data could not be read just now, so nothing is shown rather than an empty list" with a **Retry** button. Retry is a delegated listener (no inline handlers).
- Overview shows a banner naming the affected sources when `data_issues` is non-empty, and each dependent watchlist card shows "n/a" and "Unavailable" instead of a zero or "none" text.
- Successful empty results render normally (for example "No sign-ups in the last 30 days", an empty month).

A real defect this exposed: `owner-retailer-profile` selected `internal_contacts.venue_id`, a column that does not exist (the column is `venue_ids`). The swallowed error meant **the deployed retailer profile has always shown "None" for store contacts.** Fixed. It is a display bug only, but it is exactly the OV-2 failure mode.

## OV-3: real dates, canonical ids, complete data

Validation, before any data read:

- `from` and `to` go through the existing strict `parseYmd` (`api/_local-time.js`): real calendar days only, no trailing junk.
- Span is counted **inclusive of both ends** and must be 1 to 62 days. Reversed ranges are 400.
- `retailer_id`, `brand_id` use the canonical `isUuid` (8-4-4-4-12 hex).
- Order in the calendar and the two profile actions is now: validate, then verify the owner session, then read data. The only database call before a 400 is the binding module's `rpc/get_deployment_identity` project-identity check, which every route performs; no session or data table is touched.

Completeness:

- New `sbAll(path, {max})` pages a PostgREST read with `Range` headers and `Prefer: count=exact` until the exact total from `Content-Range`. The next page starts after the rows actually returned, so a server `max_rows` smaller than the requested page still pages correctly. Every call site passes a deterministic order ending in a unique column (`...,id.asc`). Any failed page throws. It returns `{rows, total, complete}`; `complete` is false only when the caller's `max` stopped it.
- Calendar, brand list, brand profile, retailer profile (venues, contacts, admins, upcoming, brand rollup), retailer list and owner metrics all use it. Responses carry `total` and `complete` flags; the page labels partial lists ("showing N of M (partial)", "Demo counts are partial", "By retailer (partial)").
- Brand rollups are keyed by **retailer id** in a `Map`. Retailer rollups are keyed by **brand id** (brand name only when a booking has no brand id). Response shapes changed from name-keyed objects to arrays; the page was updated with them.
- The brand profile's paid column is labelled "Paid (booking records)" and is summed over all of the brand's bookings, not the last 100. It is not financial accounting.
- Removable/no-history hints no longer exist in this branch.

Hosted setting observed: on demohub-rebuild-check a plain unpaged read of 1005 rows returned **1000** rows, so the project's cap is 1000. demohub-prod's cap was not checked (no production access in this work); the paging does not depend on its value.

## OV-4: small UI accuracy fixes

- `fmtD`: date-only pattern is `/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/` (the deployed one had lost its backslashes and never matched).
- `coiPill`: compares the expiry date with the viewer's local calendar day as strings; a certificate is valid through its expiry date. Approved without an expiry shows an amber "COI approved · expiry unknown". Labels state review status and the document's date ("COI approved · expires Sep 30, 2027", "COI expired Sep 28, 2026"); nothing claims coverage of a demo.
- Calendar: bookings carry `retailer_tz`; the retailer list carries `timezone`. The page says "Times are each store's local time" and the detail line reads "11:00 AM store time (PDT)". Times are not converted to one zone.
- Stale loads: each calendar render snapshots year, month and retailer filter and takes a sequence number; a response that is no longer the latest is dropped, for success and error alike.
- Inactivity card: now "No booking made in 60 days (brands signed up 60+ days ago; counts when a booking was made, not when the demo runs)". It measures the latest `created_at` of the brand's bookings or legacy demo records. Before, it looked only at the legacy `demos` table. Empty text is "No brands meet this rule." The 60-day account-age exclusion and 30-day sign-up window are unchanged.
- Sensitive-column and escaped-text protections kept; no session, token or signed-document fields were added.

## Evidence (observed 2026-09-29)

`tests/owner_directory.smoke.mjs`: **57 passed, 0 failed** against demohub-rebuild-check. Groups:

| Area | What is asserted |
|---|---|
| Access, 5 actions | anonymous 401, retailer staff 401, brand session 401, cross-origin POST with the owner cookie 403 `cross_origin_denied` |
| Shapes | list, profiles, retailer list and calendar return expected fields, complete flags, totals; sensitive-column regex clean (fixture brand has `password_hash` set) |
| Validation, 10 cases | impossible month `2026-99-01..02`, Feb 29 2027, day 00, text, trailing junk, reversed, 63 days, 152 days, 36 hyphens, 36 hex without dashes: all 400 with zero session/data reads; malformed brand and retailer ids likewise |
| Validation, accepted | exactly 62 days (`2027-01-01..2027-03-03`), Feb 29 2028, single day |
| Failures, 16 cases | each read of each action forced to HTTP 500 (bookings, retailers, venues, brands, settings, internal_contacts, retailer_admins): 503 with `retry: true` |
| Success-empty | a month with no bookings is 200, zero bookings, complete |
| Paging, simulated | bookings reads forced to 2 rows per response: 5 of 5 returned in date order over 3 pages, complete |
| Paging, real cap | 1005 real bookings for one fixture retailer: plain read returns 1000; the calendar route returns all 1005, unique ids, `complete: true` |
| Duplicate names | two retailers named "Directory Fixture Market": brand profile keeps two rollup rows with their own paid totals; list shows two retailers; calendar carries each store's own zone (New York vs Los Angeles) |
| Overview | today's sign-up appears in new sign-ups and not in inactivity; all `watchlist_ok` true and no `data_issues` normally; with bookings failing, `data_issues` names it and new sign-ups, dormant and inactivity are false while without-COI stays true |

Browser (local preview, `fetch` stubbed with the new response shapes, no console errors):

- Two overlapping calendar loads, September resolving after October: the page shows October and only October's booking.
- Calendar 503 shows the retry state; Retry reloads and renders the month. Brands 503 shows its retry state.
- Overview with a failed bookings read: banner "Some data could not be loaded completely. bookings (unavailable)", three cards "n/a / Unavailable", without-COI still listed.
- `coiPill`: expiry today "COI approved · expires Sep 29, 2026", yesterday "COI expired Sep 28, 2026", no expiry "expiry unknown".
- Detail line "Oct 12, 2026 · 11:00 AM store time (PDT)".

`npm run check`: migrations, module loads, undefined identifiers and binding scan all pass. Test fixtures were removed after each run; two stale fixtures from an earlier run today (one retailer with a venue, one brand, no bookings) were found on demohub-rebuild-check and deleted.

## Not done, and why

- Hard deletion: deferred per OV-1 (see Scope).
- demohub-prod row cap not checked (no production access in this task).
- A committed DOM e2e: Playwright is still not installed locally; the browser assertions above are manual and reproducible from the stub script.
- "Upcoming" in the directory still uses the UTC date as "today" (pre-existing; off by one only in the evening Pacific time). Not changed in this patch.
- `cancellation_mode` validation: out of scope, as directed.
- Live owner sign-in after a deploy remains an operator smoke check for David.

## Deploy and rollback

Deploy = merge `feat/owner-visibility-v2` into `main` on David's "deploy". This brings `d9e49b6` (calendar, new sign-ups) and `255c925` together. `feat/owner-brand-remove` is **not** merged. No migration or env change. Rollback = revert `255c925` and `d9e49b6`; no data is written by any of these actions.
