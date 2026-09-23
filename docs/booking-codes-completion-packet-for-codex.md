# Demohub — booking codes: completion packet (Codex review 2026-09-22, BC-1…BC-7)

Branch `feat/booking-codes` @ **`3cdc931`** (previous review HEAD `d98950a`; base = production `main` `b82ef40`). Still **not deployed**; migration 0085 (revised) is applied only to demohub-rebuild-check (`tileejdviuvijumjeplv`), where every test below ran with synthetic fixtures. No real payment, no production access, no mail sent (harness spy). Each item: defect reproduced → bounded fix → listed acceptance cases → persisted state and outbound-call assertions → full rerun after the final change.

Changed files: `supabase/migrations/0085_booking_codes.sql`, `api/_booking-codes.js`, `api/booking-code.js`, `api/book.js`, `api/booking-action.js`, `api/_fulfillment.js`, `r/gus/index.html`, `r/gus/admin/index.html`, `owner/index.html`, `tests/booking_codes.test.mjs`, `docs/booking-codes.md`.

## BC-1 — generated button handlers (release blocker) — fixed

Reproduced: `onclick="openRetailerProfile("uuid")"` — the interpolated quote closed the attribute; the buttons did nothing. Fix: no string-built handlers anywhere; delegated `click` listeners on the rendered container (guarded against re-wiring) read `data-act` / `data-rid` / `data-cid` / `data-code`; displayed text still escaped.
Acceptance (real DOM clicks on the local preview, handlers stubbed to record their arguments, `window.onerror` captured): owner list rendered **twice** (re-render), Open clicked on **two** retailers → `open(aaaa…)`, `open(bbbb…)`; Generate → `gen(bbbb…)`; Turn off → `off(bbbb…, c1c1…)`; retailer card rendered twice, Copy → `copy('GUS-SOON-ZZZZZZZZ', BUTTON)`, Turn off ×2 → the two distinct code ids; **0 console errors**; a slug containing `"><img src=x onerror=1>` and a note containing `<i>` injected nothing (no `img`/`i` element created).

## BC-2 — multi-demo semantics (release blocker) — fixed, smallest safe contract

Contract: **one code covers exactly one explicitly chosen cart item**; the rest stay full price in ordinary grouped checkout. The page: a code auto-assigns only when the cart has one item; otherwise each eligible item shows "use code here" (a delegated listener sets the assignment); only the assigned item is priced $0; an item inside the notice window without the code is labelled "needs short-notice code" and the submit button is disabled until it is covered or removed. Submission sends `booking_code` + `op_key` only for the assigned item. Server side, each `/api/book` request is one booking with at most one code, so "one use = one demo" is enforced by the transaction (BC-3), not by the UI.
Results handling: succeeded items leave the cart (cannot be resubmitted); free bookings are reported as **submitted / awaiting confirmation**; failed items stay in the cart with per-item messages; payment is offered only for the unpaid full-price subset (`payPendingBookings` → checkout with those ids); a free id is never sent to checkout; code input/button/calendar/price reset on completion or removal.
Acceptance (browser, recorded): two-item cart + unassigned no-fee code → `$30 / $30`, total `$60`, two "use code here" buttons (no misleading all-free total); assign to item 2 → `$30 / $0`, total `$30`; add a third item 2 days out with a short-notice code unassigned → submit disabled, "A demo needs a short-notice code", item flagged; assign → enabled, `$90`. Server (`booking_codes.test.mjs`): single-use code, two concurrent bookings → exactly one wins, the other `code_used_up` with no surviving row, one redemption, `use_count` 1 ("concurrent last-use race"); one item failing capacity (`slot_full`) is reported per item while the others proceed (route-flow behaviour unchanged). Multi-demo refund isolation: `fulfillment_lifecycle` 110/110 unchanged.

## BC-3 — creation/redemption reliability (release blocker) — fixed

`booking_create_with_code(op_key, fingerprint, brand, retailer, payload, code)`: inserts the idempotency row (`booking_operations`, `ON CONFLICT DO NOTHING` then `FOR UPDATE`, so a concurrent twin waits and replays), pre-checks the code, inserts the booking (**every existing trigger runs**: slot resolution, capacity, blackouts, venue lock), redeems under the code lock, records the result — one transaction. Any refusal raises `code_rejected:<reason>` and the whole operation rolls back. The route: a completed operation is replayed **before** the code is re-checked or an attempt counted; a replay is served only for the identical payload fingerprint (`op_key_reused` 409 otherwise); an unknown outcome (5xx/timeout) returns `503 booking_outcome_unknown, retry_with_same_key: true` — the blind DELETE is gone.
Acceptance: same key after the code is exhausted by that very booking → 200 `replay:true`, same booking id, still 1 use / 1 redemption / 1 operation row; same key + different payload → 409; **failure injected after the booking insert** (redeem refuses a fee waiver on a held payload) → RPC error `code_rejected:booking_not_redeemable`, booking count unchanged, 0 redemptions, `use_count` 0, no operation result; concurrent last-use race (above); checkout-then-redeem → `booking_in_checkout`; redeem-then-checkout → route `booking_fee_waived` **and** a direct allocation insert refused by the trigger; no mixed paid/waived state anywhere.

## BC-4 — single-use default (release blocker) — fixed

`validateCreate`: omitted → 1; explicit 1 / N / `'unlimited'` (string) → as given; `''`, `null`, `true/false`, `1.5`, `0`, `5000`, `'many'`, `'1e3'`, `' 2'` → `invalid_max_uses`. Database: `max_uses DEFAULT 1` (a direct insert without the column gets 1 — asserted). Both UIs send `'unlimited'` explicitly. Prefix padding: `'x'`→`DHX-…`, `''`→`DH-…`, `'!!'`, `'a-b'`, `'日本'` all produce codes that satisfy `CODE_RE` and the DB constraint (asserted). Existing rows: none in production (feature never deployed); test rows unchanged.

## BC-5 — guessing defences — done

Random part is now **8 symbols** (40 bits), rejection-sampled from the 32-symbol alphabet. Limiter `booking_code_attempt(brand, retailer, net_hash)` — database-backed (advisory lock + insert in one call, so it holds across serverless instances), covering **both** `/api/booking-code` and code-bearing `/api/book`: 12 per brand+retailer / 15 min, 40 per network hash / 15 min; `429` + `Retry-After`; fail-closed `503 code_unavailable` when unreachable; the address is SHA-256-hashed with a fixed salt before storage; raw codes are not logged. Thresholds documented in `docs/booking-codes.md`.
Acceptance: 14 previews → 12× `400`, then `429` with `Retry-After`; the next code-bearing `/api/book` is `429` and no booking was created; a no-code booking in the same state is `200`; 40 rows from one network hash by other brands throttle this brand's preview (`429`); stored `net_hash` is a 32-hex hash, not the address; direct RPC from a second "process" sees the same counts; a valid code previewed at another retailer → `code_not_found`; replays are not counted.

## BC-6 — dates — done (one decision open)

One policy, both sides in the **retailer's** calendar: the store's `advance_booking_days` applies; a short-notice code relaxes a positive minimum to **tomorrow** and never tightens (0-day store stays 0); nothing before today; a same-day slot whose canonical start instant has passed → `slot_started`; one captured clock per request; settings read failure → `503 settings_unavailable`. The page computes "today" with `Intl.DateTimeFormat(timeZone = retailer.timezone)` and compares Y-M-D strings; the calendar minimum is the store's, or the code's while the code is unassigned.
Acceptance: LA 23:59 vs UTC next day → `2026-09-22` / `2026-09-23`; DST day (Mar 8) +1 → Mar 9; 0-day store books tomorrow with no code and **still tomorrow with a code** (not tightened); today's 9 AM slot at 16:00 LA → `slot_started`; retailer-local yesterday → `date_in_past`; 15 days out accepted, 12 days out refused with `earliest_date`; code removal re-blocks a short-notice item (browser). Held + short-notice: the RPC allows the stamp; hold expiry and COI gates are untouched (`fulfillment_lifecycle` 110/110); a **no-fee** code on a held booking is refused (`coi_required_for_free_booking`).
**Open — David:** Gus's live minimum is 14 days and will now be enforced. Awaiting his confirmation; no other value was chosen.

## BC-7 — free-booking lifecycle — done, without touching payments

UI now says "submitted — no payment needed … awaiting confirmation" (auto-confirm: "usually within a minute"). Before promotion, cancel returns a defined `409 awaiting_confirmation`. Waived bookings project a **$0** demo from the worker (`p_demo_fee: 0`) and from manual confirm (fee override ignored), so monthly summaries (`demos.demo_fee`) and owner metrics do not count the venue's list fee.
Acceptance (all with the harness Stripe spy; delta = 0 for every free booking): auto-confirm ON → worker promotes to confirmed, demo row `demo_fee 0`, fulfilment `done`; retailer cancel → cancelled, still `waived/0`, no `refund_operations` row, demo retired; repeated cancel → 409, nothing resurrected; redemption row kept, use not replenished; auto-confirm OFF → promoted to **pending**, no demo, then decline → declined; manual confirm of a pending free booking → confirmed with a $0 demo, no capture; zero `payment_allocations` for all three free bookings.

## Migration / ledger answers acted on

Trigger kept as defence in depth; both lock orders tested. Free/no-ledger model kept; `paid_at` on a waiver is not treated as revenue (demo fee 0). The raw 0085 file stays unguarded; the production paste will be the guarded operator wrapper (ledger head 0084, project identity, zero pre-existing rows) rehearsed on the test project — not yet produced. Rollback = disable issuance/redemption, keep readers, never delete history (documented).

## Test evidence (environment: demohub-rebuild-check)

`tests/booking_codes.test.mjs` **79/79** (was 42). Reruns after the final change: route flows 191, store contact notifications 117, notification worker 86, capacity guard 35, slots/blackouts 97, **fulfillment lifecycle 110**, payment ledger adversarial 63, isolation matrix 45, compliance tenant 35, support access 125, owner booking events 19 — all 0 failed. `npm run check` clean; `check-migrations` clean (86 files). CI clean-build gate not dispatched (it wipes the test project's retained backup-reader identity; a disposable target would be needed).

## Remaining gaps, stated plainly

1. Gus's 14-day rule needs David's yes (BC-6).
2. Browser evidence is recorded assertions from real clicks on the local preview, not a Playwright e2e file in the repo; the three UIs have no committed DOM test.
3. The 40-per-network budget uses `x-forwarded-for` as Vercel supplies it; behind a shared NAT that budget can be reached by unrelated brands (by design: a coarse abuse cap, not a per-user limit).
4. The guarded production paste for 0085 is not written yet; it will be produced and rehearsed when David approves deployment.

---

## Addendum (2026-09-23) — branch now `0e86d4d`; UI changes after David's preview test

The completion packet above describes `3cdc931`. Five further commits, all UI, none touching the server, migration, money rule or tests' server assertions:

| Commit | Change | Why |
|---|---|---|
| `67d9ed0` | Tooltips on the code-kind options + a live one-line explanation under the selector (retailer card and owner portal) | David could not tell the three kinds apart |
| `1257b33` | **Expires** is a fixed list (Never / 7 / 14 / 30 (default) / 90 days) instead of a date picker; the code list reloads every time the Settings tab is shown; the "Demohub support activity" card reworded to "Help from Demohub" | Standard options requested; the list depended on the login path and showed empty after magic-link sign-in; the support wording read as invasive |
| `4d38750` | Support card keeps the three disclosed limits (24 h consent, ≤ 4 h visits, OFF ends a visit at once) in plain words; `support_access` test updated for the rename (125/125) | Disclosures are reviewed behaviour; only the tone changed |
| `0e86d4d` | New **Policies** tab in the retailer admin: the "Almost set up" nudge, a **Cancellation policy** card (the 14-day / non-refundable choice, moved out of Booking preferences; saves through the same `saveBookingPrefs`, status mirrored) and the **Demo conduct policy** card (unchanged editor/upload). Tab controller: `policiesSection` added to `TABS`; the two cards and the nudge carry `data-tab="policiesSection"` | The policies brands sign were reachable only through a small nudge |

Verified on the local preview by DOM inspection (no console errors): the tab link exists; the pane holds exactly nudge → Cancellation policy → Demo conduct policy in that order; the cancellation radios are no longer in Settings; Booking preferences and Booking codes remain in Settings; the save-status mirror element exists. `npm run check` clean; `booking_codes` 79/79 (one date assertion now uses retailer-local yesterday — it had been UTC-based and broke after 00:00Z); `support_access` 125/125.

Preview evidence for the code flow: a Vercel Preview of the branch (aliased onto the Preview-trusted origin, since `SITE_ORIGIN` is scoped to that alias and CSRF refused any other host) against demohub-rebuild-check with a seeded "Gus (TEST)" store; David signed in via magic link and generated `GUS-VIP-…` through the real admin route (created_by = his login). The end-to-end brand booking on the preview is still to be done by David.

Open decision unchanged: Gus's 14-day advance-notice minimum (David has not yet confirmed).
