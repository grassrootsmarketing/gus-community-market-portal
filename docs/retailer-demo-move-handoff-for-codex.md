# Retailer-initiated demo moves with brand reconfirmation: handoff for Codex review

Branch `feat/retailer-demo-move` (feature commit `e12ec81`, two test-label follow-ups on the same branch). Not merged, not deployed. Migration `0094_retailer_demo_move.sql` is applied to demohub-rebuild-check only; the production paste kit is `Documents/Codex/cutover-kit/0094-retailer-demo-move-paste.sql` (manifest alongside).

## 1. The product decision (David, 2026-10-16)

The store owns its calendar. A retailer may move a confirmed (or paid pending) demo to any slot its location offers, immediately, without asking the brand first and without any lead-time restriction. The brand is told at once and has a reconfirmation window to confirm or say it cannot make it. Silence at the deadline, or a decline, cancels the demo with a FULL refund (the store changed the terms; a kept charge is a chargeback). The existing "propose a new date, brand accepts" flow (0074) stays available from the same dialog for stores that prefer to ask first. The owner acts through the existing "Open as retailer" support access, never through a new bypass.

Window: 72 hours from the move, capped at 24 hours before the new demo start, never shorter than 12 hours (a demo inside the next day keeps the start itself as the deadline). Nudges to the brand at +24h and +48h while unanswered.

## 2. What was built

### Database (0094, forward-only, idempotent, no row rewrites)
- `booking_moves`: one row per move. `status` pending | confirmed | declined | lapsed | superseded; `settled_at` + `refund_status` once a decline/lapse has been cancelled and refunded; partial unique index: ONE pending move per booking. service_role only.
- `move_booking_by_retailer(demo, retailer, date, time, note, actor, hours)`: the one transaction. Lock order bookings then demos (as accept_reschedule / booking_transition). Refusals with no side effect: not_found, no_booking, not_active, note_too_long, date_in_past, same_slot (judged on the resolved instant: '10:00' and '10:00 AM' are one slot), coi_not_covered (the 0074 rule in SQL), and every slot/capacity trigger reason (slot_full, slot_not_offered, slot_outside_hours, date_blackout, venue_closed, slot_config_invalid, venue_hours_not_set, invalid_local_time) plus time_in_past (same-day move to a start already passed; raised inside the sub-transaction so the UPDATE rolls back). On success: bookings moved with schedule_revision +1 (the snapshot trigger recomputes start_at), demos projected and any open proposal cleared, earlier pending move superseded, the move row written with its deadline, `demo_rescheduled` event (store contacts, existing kind) and `demo_moved` event (brand, new kind), old occurrence's pending deliveries retired.
- `respond_booking_move(move, brand, decision, actor)`: brand identity from the booking, refuses unless the move is pending, the booking active and on the move's revision. confirm -> 'confirmed'; decline -> 'declined' (settlement is the application's, see below).
- `lapse_booking_moves(limit)`: FOR UPDATE SKIP LOCKED claim of pending moves past their deadline, status -> 'lapsed', rows returned.
- `notification_events` kind CHECK re-declared to admit `demo_moved` and `demo_move_cancelled`.

### Money and state (application)
- `api/_booking-refund.js`: `refundPaymentIntent` and `reserveAndRefund` lifted VERBATIM out of `api/booking-action.js` (the key now comes from the validated binding's `stripeKey` instead of `process.env`; same value). booking-action calls the shared functions through thin wrappers; its behaviour is unchanged (route_flows 191/191 after the change).
- `api/_booking-moves.js` `settleMove(b, move, { outcome })`: refund in full via `refund_reserve_cas` under operation key `move_declined` / `move_lapsed` (a retry returns the same reservation and the same Stripe idempotency key), then `booking_transition` cancel with a recorded cancel_reason, then stamp `settled_at` + `refund_status` and write ONE `demo_move_cancelled` event (idempotent on transition_id). A failed transition after the refund step opens one deduplicated `settlement_exception` case (`move_settle:<move id>`) and leaves the move unsettled. A booking found `held` is left to an operator (no money moved).
- `sweepMoves` runs inside `api/refund-worker.js` every 15 minutes (required job, always on): lapse due moves, settle every unsettled declined/lapsed move. Counts in the heartbeat summary; a failed settlement makes the run 'failed' (500) like any other per-item failure.

### Routes
- `api/booking-action.js` action `move` (owner/admin/manager): validates, resolves the requested slot against what the venue offers (friendly refusal; the database re-checks under the lock), calls the RPC, maps reasons to messages. No request-path mail.
- `api/brand-account.js` action `move-respond` (brand session): RPC, then on decline `settleMove`; if settlement fails here the worker finishes it within 15 minutes and the response says so. `data` now attaches `pending_move` to each demo.
- `api/admin.js` `data` attaches `pending_move` to each demo for the pill.

### Outbox (api/_notification-outbox.js, api/_notification-mail.js)
- Fan-out of `demo_moved` / `demo_move_cancelled` to the brand's account email and team members, keyed on the move id; a moved notice for a move already answered is fanned out as skipped.
- Worker step `move_reminders`: `demo_move_reminder` deliveries at +24h / +48h per recipient, no event row, `too_close_to_deadline` and `due_before_scheduling` recorded.
- Dispatch recheck reads the CURRENT move and booking: moved/reminder send only while pending, active, on the move's revision and before the deadline (`move_<status>`, `booking_<status>`, `rescheduled`, `deadline_passed`, `expired`); cancelled sends only once the move is declined/lapsed and the booking inactive (`booking_still_active`). Replay rebuilds nothing.
- Three builders: moved (old and new slot, deadline in the store zone, the store's note escaped, "refunded in full"), reminder (hours/days left), cancelled (declined vs lapsed wording, refund line from `refund_status`). Links go to the brand dashboard.

### UI
- Retailer admin (`r/gus/admin/index.html`): the Reschedule dialog is now "Move this demo" by default (date, slot, optional note, "Move demo"); a one-line toggle switches to the old "Propose to brand". The row shows "Moved, awaiting brand by <deadline>" while a move is pending. Tooltips explain the 72-hour rule and the full refund.
- Brand dashboard (`brand/dashboard/index.html`): a banner on the moved demo (old slot struck through, new slot, deadline, the store's note) with "Confirm new time" and "We can't make it" (confirm() guard; full-refund wording).

## 3. Evidence
- `tests/demo_move_offline.test.mjs` (37, in `npm test`): builders, fan-out, every recheck branch, reminder scheduling, settlement (paid: one Stripe call under the reservation key; unpaid: none; failed transition: one case; held: untouched), sweep idempotence.
- `tests/demo_move.test.mjs` (37, in `test:routes`, demohub-rebuild-check): real RPCs and routes: refusals (anonymous, foreign retailer, past date, same slot, long note, COI not covering, full slot), the move with revision/events/retired deliveries, outbox send with the note, reminders, brand data, confirm, stale/foreign/answered refusals, supersede chain, decline (cancel + settle, events, no Stripe call on an uncharged fixture), lapse through `sweepMoves` and through the refund-worker route.
- Regression on demohub-rebuild-check after the change: route_flows 191/191, cron_heartbeats 75/75, notification_worker 86/86, owner_booking_events 19/19. `npm run check` and `node tools/check-html-undef.mjs` green.
- Browser proof on a local server against demohub-rebuild-check: staff moved a demo from the Demos table (dialog, note, toast with the deadline, pill on the row); the brand dashboard showed the banner with the note and the deadline; Confirm cleared it and the demo stayed confirmed on the new date.

## 4. What I would like Codex to look at hardest
1. `settleMove` ordering and idempotence (refund before transition, as the retailer cancel path; retry after a crash at every step; the `held` branch).
2. The deadline formula in `move_booking_by_retailer` step 8, and whether a same-day move to a slot later today should keep a 12-hour window or the start.
3. The paid refund path is proven only offline (mocked `refund_reserve_cas`) and by the unchanged route_flows paid-cancel coverage; the database suite's decline/lapse fixtures carry no payment intent. A Stripe test-mode end-to-end on a deployed preview is still owed.
4. The brand's email CTA goes to the dashboard (sign-in required); one-click confirm links with a signed token were deliberately left out of this round.
5. `MOVE_REFUSALS` messages and the admin tooltips: wording that could mislead a store about money.

## 5. Deploy order
1. Paste 0094 on demohub-prod (kit above; guard checks production identity, 0091/0092 present, 0094 absent, `booking_moves` absent, the 0074/0076/0077 functions present).
2. Merge and deploy `feat/retailer-demo-move`. No new environment variables; the refund worker and the notification worker already run.
3. Rollback: the old code ignores `booking_moves` and the two new kinds (an unknown kind is marked fanned out with `unknown_kind`, no mail). Pending moves would stop being lapsed until the code returns; nothing is cancelled or refunded without it.
