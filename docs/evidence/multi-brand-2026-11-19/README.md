# One person, many brands: test evidence, 2026-11-19

Branch `feat/multi-brand-access`, built on main `e52d34c`. Nothing here touched demohub-prod and nothing was deployed.

## What was run

| Check | Where | Result |
| --- | --- | --- |
| `npm run check` | local | pass |
| `npm test` (now includes `tests/multi_brand_offline.test.mjs`, 55 checks) | local, no database | pass |
| Migration `0121_multi_brand_access.sql` | applied to demohub-rebuild-check in one transaction with its ledger row (ledger tail 0121) | applied, post-conditions passed |
| `tests/multi_brand_access.test.mjs` (real handlers, test database, mail spied) | demohub-rebuild-check | 53 passed, 0 failed |
| `tests/multi_brand_dom.e2e.mjs` (real browser, real handlers, test database, desktop 1280 and phone 390) | demohub-rebuild-check | 37 passed, 0 failed |
| Existing suites rerun after the change: brand_booker 49, brand_booker_corrections 38, agreement_sign_atomic 13, route_flows 192, isolation_matrix 45, payment_receipts 49, connected_checkout 32, brand_product_list 56 | demohub-rebuild-check | all pass |
| Existing browser suites rerun: brand_booker_dom 51, brand_product_list_dom 37, brand_coi_tile_dom 21, agreement_modal 18, upc_nudge_dom 24, booking_support_link_dom 10 | local pages, stubbed API | all pass |

`tests/terms_digest.test.mjs` reports one failure on this machine. It fails the same way on main `e52d34c` without this change, so it is not caused by this branch.

## Pictures in this folder

Fixture brands are made up (Summit Elixir Co is the rep's own account; Golden Tofu Co, Harbor Oat Bars, Riverbend Rice and Lakeside Lentils are the brands the rep works for). All addresses end in `@fixture.test` and no mail was sent.

1. `1-sign-in-picker-*`: after the sign-in code, "Which brand are you working on?", own brand first and marked Yours, an invitation waiting.
2. `2-header-switcher-*`, `2-switcher-open-*`, `2-account-brands-*`: the header names the active brand; one click opens the list and switches. On a phone the same control is a band under the header.
3. `3-booking-for-*`, `3-booking-switch-*`: the store's booking page says "Booking for Golden Tofu Co" with a "Switch brand" link.
4. `4-other-tab-reload-desktop`: after switching in another tab, the first tab stops and asks for a reload.
5. `5-request-sent-desktop`, `5-owner-approval-*`, `5-owner-approved-desktop`: the rep asks for access; the owner opens the emailed link signed out and approves with one button.
6. `6-owner-people-with-access-*`: the owner's Account page, "People with access", with Booking only and Full access.
