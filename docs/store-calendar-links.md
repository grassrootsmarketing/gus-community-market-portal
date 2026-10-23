# Staff calendar (0111 and 0113, 2026-10-23)

What it is: a view-only web page of a store's confirmed demos at /r/<slug>/calendar, opened from a link the store admin shares, the way the booking link is shared. No sign-in, no staff accounts, no profiles. It looks like the dashboard's Demo Calendar: a month grid with the store's locations colored in the legend, a List view for phones, Print, and a location filter on the whole-store link. Each entry shows the date, start and end time in the store's zone, the location, the brand's display name, the display names of the items being sampled, and the confirmed status. Nothing else: no contact names or details, no notes, no money, no codes, no insurance facts, no admin controls.

## For the admin: one Settings section, "Staff calendar"

- One row for **All locations** and one per location. Each row shows two links that are **always there**: the **Calendar page** link (the web page above) and the **Calendar app feed** link (the iCal feed for Google, Apple or Outlook Calendar, with the Apple, Google and Outlook shortcuts next to it). Each has a Copy button. Nothing to create: a scope that has no page link yet gets one the moment an owner or admin opens Settings.
- **Rotate** on a page link makes a new one and retires the old one at once (confirmed first). It is the one way to kick a holder of a link off; it touches no other row and never the feed link.
- A location link shows only that location and cannot be widened by editing the address. The whole-store link shows every active location and has a location filter.
- Only owners and admins see the links. Viewers see a sentence saying so.
- A store that was created without a feed key (the pilot store was one) gets its key the first time Settings is opened after this release, and migration 0113 gives one to every such store as well, so the feed links work.

## How the links are kept (0113)

Until 0113 the server kept only a hash of a page link's secret, so a link could be shown exactly once. That was rejected by the product owner on 2026-10-23: the links are shared only by store admins with their own staff, and an admin must be able to copy the current link at any time. Since 0113 each link is kept twice: the hash, which is still the only thing the visitor's token is looked up by, and the token **sealed** with AES-256-GCM under a key derived (HKDF) from the server's own secret. The database never holds the plaintext; a copy of the table reveals nothing without the server. The seal is opened only to show the admin's own list. A seal that does not open (a different deployment secret, a damaged row) is shown as "cannot be shown, Rotate", never guessed. Links recorded before 0113 have no seal: they keep working for whoever has them and show as "Rotate" in Settings until rotated.

## For the person with the link

Open it on a phone or a computer. The page opens on the current month with today ringed; previous and next month, Today, Month and List views, a location filter where the link covers several, Print for a month sheet, and a Refresh button. Tap a demo for its details. It refreshes itself every few minutes while open and when the tab comes back into view, and says when the shown calendar was last updated. If a refresh fails it keeps the last good calendar and says so; if the link has been retired it clears the calendar and says to ask the admin for a new link.

## How the secret travels

The link carries the secret after a `#`. The browser never sends that part to any server, so it is absent from request logs and from the referrer of anything the page loads. The page holds it in memory only (no web storage) and sends it to /api/store-calendar as an Authorization header and nowhere else. By a deliberate tradeoff the fragment **stays in the address bar during ordinary use**, so a reload and a copied link keep working; it does therefore appear in the browser's history and in a screenshot of the address bar. It is taken out of the address only while printing (so a printed header does not carry it) and when the link is retired. The data answers with Cache-Control no-store, Referrer-Policy no-referrer and noindex headers; the page is marked noindex and no-referrer as well. The page loads the site's font from Google Fonts like every other Demohub page; with no-referrer that request carries neither the page address nor the fragment.

## Limits, stated plainly

- Both links are bearer credentials: anyone who has one can see what it allows. They are not proof that the visitor works at the store. Share them with the team only.
- Rotating a link stops future access after the next refresh. It cannot take back screenshots, printouts or copies already made, and a page already open learns of it on its next refresh (within minutes while visible).
- A request covers at most 90 days (first to last day); the page asks for one month grid (at most 42 days) or four weeks at a time, fetches the whole displayed grid before presenting it, and shows an "Incomplete" banner (also when printed) if the server reports more demos than one answer carries.
- Reads are budgeted per client address and per link (abuse ceilings, counted atomically); a store's normal polling sits far below them. When the budget counter itself cannot be reached the page gets a temporary error, never a free pass.
- Only confirmed demos appear on the page. Pending, held, cancelled and declined requests never do, so staff do not prepare for tentative demos. The iCal feed is the older mechanism and also includes completed demos and the brand contact's name, as it always has.
- Times come from the booking's accepted schedule snapshot. A change to the store's time zone setting does not move an existing appointment. A legacy demo without a snapshot is placed from its date and time and marked on the page.
- A feed link opened in a browser (instead of added to a calendar app) shows a small Demohub page explaining that, with the real logo; a calendar app only sees the status code.

## Rollback and stopping

To stop everyone at once: the revoke function for the store (service role), or Rotate every row. Migrations 0111 to 0113 add one table, one column and the link functions and change no existing row apart from giving key-less stores a feed key; they stay in place in any rollback. A build without the page and route simply leaves the links unanswerable (404 and 405), with every row kept. A build from before 0113 cannot issue links after 0113 (the four-argument function is gone) but still resolves them.

## Not in this release

A QR code in the admin section, a Download month button on the page, and anything brand-facing. Pagination beyond the 90-day window is a follow-up before scaling.
