# Demohub: required brand product list with ordering details (design handoff for Codex, 2026-10-07)

One document: the problem, what exists today, the proposed change, data and validation, surfaces, tests, rollout, and the questions I want answered before building. Nothing is built yet. No production change is proposed by this document.

## Problem

The retailer needs to order the brand's product before a demo, so there is stock on the shelf when customers taste it. Today a brand can book without listing a single item, and even a complete item list (name, size, SKU) does not carry what a grocery buyer orders from: UPC, distributor, distributor item number, case pack. Gus's first pilot demo (Oct 13) is the motivating case: the store-side reminders now go out, but a reminder that says "Fire Season Goods, 3:00 PM" without items is a reminder the buyer cannot act on.

## What exists today (read before designing)

- **Brand profile.** `brands.products jsonb not null default '[]'`: an array of `{ id, name, size, sku }`, edited on the brand dashboard Products tab ("Items you sample"), written through `api/brand-account.js` action `profile-update` (allowlisted key `products`, `sanitizeProducts()`: max 60 items, name required and ≤120 chars, size ≤40, sku ≤60, generated `id`). Optional; most brands never fill it.
- **Booking.** The public booking page (`r/gus/index.html`) shows the signed-in brand's items as pre-checked checkboxes ("bookSkuList"), hidden entirely when the brand has none. The picked items are posted as `product_skus` and stored verbatim on `bookings.product_skus jsonb` (`api/book.js` line 100, no server-side validation of the shape beyond JSON). `demos.product_skus jsonb` mirrors it on the projection. A free-text "What are you demoing?" category is required separately (`product`).
- **Store side.** The retailer admin shows `product_skus` under the product on the booking row (two places). Store-contact emails (`api/_notification-mail.js`): the confirmed, reminder and rescheduled messages include `skuBoxHtml()` ("what they're demoing": name, size, SKU), capped at 40 items; cancellations omit it. The owner alert does not list items.
- **Brand side.** The brand dashboard shows items on its demo rows.

So the data path exists end to end; what is missing is (a) a requirement, (b) the buyer's fields, (c) their presence where the buyer reads.

## Proposed change

### 1. Item shape

Extend each item to `{ id, name, size, sku, upc, distributor, distributor_item_number, case_pack, notes }`:

| field | rule |
|---|---|
| `name` | required, ≤120 (unchanged) |
| `size` | optional, ≤40 (unchanged) |
| `sku` | optional, ≤60 (unchanged; the brand's own code) |
| `upc` | optional, digits only after stripping spaces/hyphens, 8, 12, 13 or 14 digits; stored as digits |
| `distributor` | optional, one of `unfi`, `kehe`, `direct`, `other`; free text ≤60 allowed only with `other` (`distributor_other`) |
| `distributor_item_number` | optional, ≤40 |
| `case_pack` | optional, integer 1..999 |
| `notes` | optional, ≤200 (e.g. "ships frozen", "ask for the 6-pack") |

No PII in any field. Unknown keys dropped. Same sanitizer used for the profile write and for the booking write (today the booking write stores whatever the page sent).

### 2. Requirement

A brand must have at least one item on its profile before its first booking is accepted. Enforced server-side in `api/book.js`: if the brand has no items and the request carries none, respond `400 products_required` (and the matching check at checkout/booking creation for both the immediate-charge and the provisional-hold paths). The booking page handles it in place: when the signed-in brand has no items, the "what they're demoing" step becomes a small inline editor (name, size, UPC, distributor, item number, case pack), and the entries are saved to the profile (`profile-update`) before the booking is submitted, so it is a one-time step. Returning brands see their list pre-checked as today, with an "edit items" link to the Products tab.

"At least one item" is a minimum, not a judgement of completeness: UPC and distributor stay optional, because a direct-delivery brand may have neither, but the booking page and the Products tab say plainly what the store uses them for.

### 3. Surfaces

- **Confirmation and one-week reminder (store contacts):** the item box lists name, size, UPC, distributor and item number, case pack, in a compact table instead of the current single line per item, with the heading "Order these before the demo". The three-day and morning-of reminders keep the compact one-line list (they are "it's happening", not "go order").
- **Retailer admin booking detail:** same table; copyable.
- **Owner alert:** unchanged (the owner does not order).
- **Brand dashboard Products tab:** the new fields, with a one-line explanation per field for a founder who has never been asked for a UPC.
- **Cancellations:** no item box (unchanged).

### 4. Not changing

Payment, holds, COI, scheduling, the reminder timing, the "What are you demoing?" category (kept as the brand's one-line description), the retailer approval gate, booking codes, and the pending sign-in and notification-defaults rounds. No new table; both columns stay jsonb. Historical bookings keep their stored shape; rendering tolerates both shapes (missing fields render blank).

## Validation and security notes

- The booking write validates `product_skus` with the shared sanitizer; items not matching the brand's profile are still accepted (a brand may pick a subset or add one on the spot) but are capped at 40 and shaped identically.
- The product list is brand-owned data shown to the store that confirmed the booking and to the owner; nothing new crosses tenants. Store contacts already receive these emails.
- Everything rendered is escaped (`H()` in mail, `escapeHtml` in pages); UPC digits-only prevents formatting tricks; distributor is an enum.
- Session scoping of `profile-update` and `book.js` is unchanged.

## Tests I plan

- Sanitizer: every field's limits and normalization (UPC "0 12345-67890 5" → "012345678905"; invalid lengths dropped; enum enforced; `other` text only with `other`).
- `book.js`: brand with no items and no `product_skus` → 400 `products_required`; with items on the profile → accepted and stored shaped; with items only in the request → accepted and shaped; both immediate and hold paths; capped at 40.
- `profile-update`: new fields saved, unknown keys dropped, 60-item cap, another brand's session cannot write.
- Mail: confirmed and one-week reminder render the ordering table with the new fields; three-day and morning-of render the compact list; cancellation has no box; all escaped; no em dash; tolerant of legacy `{name,size,sku}` items.
- Retailer admin and brand dashboard DOM: table renders, legacy items render, hostile strings escaped.
- Booking page DOM: brand with no items sees the inline editor, cannot submit until one item has a name, the items save to the profile and ride the booking; returning brand sees the pre-checked list.
- Existing suites: route_flows, provisional/holds, notification mail suites unchanged or updated for the table.

## Rollout

Code-only (no migration: both columns are jsonb). One deploy, no flag needed, since brands with items see no change until they open the Products tab, and brands without items are asked at their next booking. Rollback: redeploy the previous main; stored items with new fields remain valid for the old renderers (extra keys ignored). No production data edits.

## Questions for Codex

1. Is "at least one item" the right minimum, or should UPC or distributor be required when the retailer's settings say the store orders through a distributor? (I lean minimum-only for the pilot; a per-store "require ordering details" toggle could come later.)
2. Should the booking write reject items that do not appear on the brand's profile, or accept them and add them to the profile? I propose accept-and-save, since a brand adding an item at booking time is the common case.
3. Any objection to the ordering table living in the confirmation and the one-week reminder only, with the shorter list in the later reminders?
4. Anything in the item fields you consider sensitive or out of place for store-contact emails?

## TLDR (for David)

Brands can already list what they'll demo, but it's optional and the list doesn't have what a buyer needs to order. This plan makes every brand list at least one item before their first booking, adds the ordering details (UPC, distributor, item number, case size), and puts them in the confirmation and the one-week reminder so the store can order in time. No database migration, one deploy, no change to payments or scheduling. Codex reviews this design first; then I build it.
