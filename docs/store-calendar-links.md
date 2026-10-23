# Shareable store calendar links (0111, 2026-10-23)

What it is: a view-only web page of a store's confirmed demos at /r/<slug>/calendar, opened from a link the store admin shares, the way the booking link is shared. No sign-in, no staff accounts, no profiles. Each entry shows the date, start and end time in the store's zone, the location, the brand's display name, the display names of the items being sampled, and the confirmed status. Nothing else: no contact names or details, no notes, no money, no codes, no insurance facts, no admin controls.

## For the admin (Settings, next to the calendar feeds)

- **Create link** for "All locations" or for one location. The link is shown once, with a Copy button. It is not shown again: the server keeps only a hash of the secret, so a later "copy" is a **Rotate**, which issues a new link and retires the old one at once.
- **Stop sharing** retires a scope's link without issuing a new one.
- A location link shows only that location and cannot be widened by editing the address. The whole-store link shows every active location and has a location filter.
- Rotating or stopping one link does not touch the others, and never touches the iCal calendar feeds in the same Settings section (those keep their own key).
- Only owners and admins can create, rotate or stop links. Viewers see the box but cannot act.

## For the person with the link

Open it on a phone or a computer. The page opens on the current week with today highlighted; Week and List views, previous and next week, a location filter where the link covers several, Print for a week sheet, and a Refresh button. It refreshes itself every few minutes while open and when the tab comes back into view, and says when the shown calendar was last updated. If a refresh fails it keeps the last good calendar and says so; if the link has been retired it clears the calendar and says to ask the admin for a new link.

## How the secret travels

The link carries the secret after a `#`. The browser never sends that part to any server, so it is absent from request logs and from the referrer of anything the page loads. The page holds it in memory only (no web storage) and sends it to /api/store-calendar as an Authorization header and nowhere else. By a deliberate tradeoff the fragment **stays in the address bar during ordinary use**, so a reload and a copied link keep working; it does therefore appear in the browser's history and in a screenshot of the address bar. It is taken out of the address only while printing (so a printed header does not carry it) and when the link is retired. The data answers with Cache-Control no-store, Referrer-Policy no-referrer and noindex headers; the page is marked noindex and no-referrer as well, uses the system font and loads nothing from a third party.

## Limits, stated plainly

- The link is a bearer credential: anyone who has it can see what it allows. It is not proof that the visitor works at the store.
- Retiring a link stops future access after the next refresh. It cannot take back screenshots, printouts or copies already made, and a page already open learns of it on its next refresh (within minutes while visible).
- A request covers at most 90 days (first to last day); the page asks for a week or four weeks at a time, fetches the whole displayed week before presenting it, and shows an "Incomplete" banner (also when printed) if the server reports more demos than one answer carries.
- Reads are budgeted per client address and per link (abuse ceilings, counted atomically); a store's normal polling sits far below them. When the budget counter itself cannot be reached the page gets a temporary error, never a free pass.
- Only confirmed demos appear. Pending, held, cancelled and declined requests never do, so staff do not prepare for tentative demos.
- Times come from the booking's accepted schedule snapshot. A change to the store's time zone setting does not move an existing appointment. A legacy demo without a snapshot is placed from its date and time and marked on the page.

## Rollback and stopping

To stop everyone at once: Stop sharing on every scope in Settings (or run the revoke function for the store). The page then shows the retired message. Migration 0111 adds one table and three functions and changes nothing existing; it stays in place in any rollback. A build without the page and route simply leaves the links unanswerable (404 and 405), with every row kept.

## Not in this release

Subscribe in a calendar app and Download month buttons for this page (the existing iCal feeds remain as they are), a QR code in the admin box, and anything brand-facing. Pagination beyond the 90-day window is a follow-up before scaling.
