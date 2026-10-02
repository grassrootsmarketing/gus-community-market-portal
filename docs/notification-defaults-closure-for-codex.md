# Demohub notification defaults: closure packet for Codex (2026-10-02)

Final SHA: `feat/notification-defaults` @ **`e8d0148`** = original candidate `b425b24` + merge of production `main` `ae22e3f` (7f931aa) + the ND-1/ND-2/ND-3 commit. Rollback artifact: `fallback/notification-defaults-ui-revert` @ **`ecbbd5a`**. Migration kit: `Documents/Codex/cutover-kit/0088-settings-notification-defaults-paste.sql` (sha256 `2e0ef8d6d1cdc1310bfac980fc412254d6b848bd0c2d180a739dc586dc665981`; migration file sha256 `7d02fb24c54273866604657df48200fc3d36c0a50728d0fbdca0b589cdbe4e62`; `MANIFEST-0088.json`). Production unchanged at `ae22e3f`. Nothing touched demohub-prod. All suites ran on demohub-rebuild-check (`tileejdviuvijumjeplv`) with mail intercepted and the worker flag on in the harness.

## A correction to my own earlier evidence (test-runner working directory)

My scratch test runner changed into the main checkout before running, so every earlier claim of the form "ran suite X in that branch's own worktree" (the b425b24 candidate, the retailer-approval fallback `c624bb6`, the superseded `hotfix/approval-gate-only`, the `255c925` base comparison) actually ran against the main working tree at the time. The results reported for the working tree itself were real. For this round I added a runner that respects the current directory and redid the affected runs:

- `b425b24` (original candidate) in its own directory with the new tests: **7 failures** (below), exactly the defect you reproduced.
- `c624bb6` (retailer-approval fallback) in its own directory: `retailer_gate.smoke` 10/10, `owner_directory.smoke` 57/57, `route_flows` 191/191, `npm run check` clean. The claim stands; it is now actually observed.
- `hotfix/approval-gate-only` @ 9e64ad5 was superseded by `c624bb6` and is not re-verified.

## ND-1 (complete): an unreadable store default is an error

`api/_notification-outbox.js`:
- New `loadStoreDefaults(b, cache, retailerId, {fresh})`, the one loader. Resolves only on a successful, structurally valid read: the saved default object, or `null` when the row has no default or the retailer has no settings row (zero rows; the documented legacy absence that `resolveContactPrefs` maps to the Release A fallback). Any database/network/timeout failure propagates as the existing typed `OutboxError` (`db_get_failed`, `db_unreachable`, `db_timeout`); a non-array body or a non-object default throws `settings_read_malformed` / `settings_defaults_malformed`. Cache (`defaultsByRetailer`) holds successful reads only; `fresh: true` bypasses it.
- `loadContactsForRetailer` (fan-out and scheduling) calls the loader with no catch. A failure propagates: fan-out catches per event (`fanout:<kind>:<code>`, event stays unfanned), scheduling catches per booking (`schedule:<code>`, no rows inserted); the contact list is cached only after the defaults read succeeded; the run reports `ok: false` and the heartbeat records it.
- Dispatch (`recheckAndBuild`): a custom contact (`prefsAreSet`) decides on its own prefs with no defaults read. A following contact gets a **fresh** read; a failure propagates to `processClaimed`'s existing error path (`outcome: 'error'`), which reports it and leaves the claim with its lease. Nothing is marked opted_out, accepted or failed on a read we could not make; no payload is frozen or sent. Frozen payloads, idempotency keys, dedupe, scope checks and expiry are unchanged.

Decisions 1 to 5 of your review are reflected as written (NULL/`{}` follow; custom untouched; successful reads cached per run for scheduling/fan-out; fresh read at dispatch, not a run-wide dispatch cache; no atomic send/preference claim).

## ND-2 (complete): copy and comments

- Contact paragraph: day-based reminders "around 9 am in your store's time zone", morning-of "around 7 am when the demo starts later than that", one-hour "about an hour before the start"; em dashes removed.
- Card intro adds: "Only upcoming reminder times are scheduled: saving defaults does not send reminders whose time has already passed."
- Unset-default status (card, contact editor summary, owner mirror): "Contacts following store defaults receive confirmation, cancellation and reschedule emails, but no reminders until defaults are saved. Custom contacts keep their own settings."
- Stale comments corrected in `_notification-prefs.js` (header rule) and the admin page (`NOTIF_PREFS_DEFAULTS` is historical; new contacts follow the store).
- Observed in the browser with one following and one custom contact and no saved default: card status "Not set yet. Contacts following store defaults receive … Custom contacts keep their own settings. 1 of 2 store contacts follows these defaults; 1 has custom settings."; editor summary "No defaults saved yet: following contacts get confirmation, cancellation and reschedule emails and no reminders."

## ND-3 (complete): integration, kit, authorization, rollback

- **Integration**: `main` (`ae22e3f`: server lead-time rule, Settings-save speed, lead-time presets) merged into the branch (7f931aa); the one conflict was both branches adding settings-PATCH validation in `api/admin.js`, now one block validating `advance_booking_days` (0..365) and `notification_defaults`. `npm run check` clean (88 migrations).
- **Guarded 0088 kit**: one transaction; guards: identity = production, ledger from 0083 exactly `0083,0084,0086,0087` (0085 deliberately absent; 0088 absent), `public.settings` present, existing `notification_defaults` column must be absent or already `jsonb` (any other type aborts); unmodified migration body (ADD COLUMN IF NOT EXISTS jsonb + comment, no row rewrites); postcondition asserts `jsonb` and nullable; exactly one ledger row; read-only verify select (ledger tail, column type, count of stores with defaults = 0 expected). Rehearsed on demohub-rebuild-check: guard refused ("identifies as staging, not production"), as designed. The booking-codes 0085 kit was regenerated to expect `0083,0084,0086,0087,0088` (same migration sha `f20246ca…`); its own guard also refused the test project.
- **Authorization and isolation tests** (in `tests/notification_defaults.test.mjs`): a viewer's PATCH of `notification_defaults` is refused and the value is unchanged; another retailer's owner PATCHing this store's settings row is refused and the value is unchanged; an unrelated Settings save (fee + lead time) preserves `notification_defaults`; saving defaults preserves fee and lead time.
- **Rollback artifact** `fallback/notification-defaults-ui-revert` @ `ecbbd5a`: forward commit on `e8d0148` restoring `r/gus/admin/index.html` and `owner/index.html` to `origin/main`, keeping the resolver, the corrected outbox, the `admin.js` validation and migration 0088. A saved default keeps being honoured; the pre-feature worker is never reinstated. Verified **in its own directory**: `notification_defaults` 31/31 (includes the store-level confirmation-off + queued-reminder case: no formerly disabled lifecycle mail is enabled, the queued reminder dispatches on the real default), `store_contact_notifications` 117/117, `lead_time_setting` 12/12, `npm run check`. If an incident needs more than the UI withdrawn: pause the worker under operator authorization (`NOTIFICATION_WORKER_ENABLED` unset in Production + redeploy), which also delays owner and COI notices, preserve queued rows, forward-fix. No deletion of saved defaults, delivery rows or contact preferences.

## Evidence

`tests/notification_defaults.test.mjs` on `e8d0148`: **31 passed, 0 failed**. The same file on `b425b24`, run in that commit's own directory: **20 passed, 7 failed**, the failures being exactly ND-1 A (run reported ok, event fanned, 3 rows), ND-1 B ×2 (rejection and malformed body read as "no default"), ND-1 C (confirmation sent although the store default has it off), ND-1 D and F (reminder marked `skipped / opted_out`).

| Case (new in this round) | Result on e8d0148 |
|---|---|
| ND-1 A: settings read HTTP 500 during fan-out + scheduling | run 500 / `ok:false` naming `db_get_failed`; event unfanned; zero rows; zero mail |
| ND-1 B: network rejection | `db_unreachable`; event unfanned; zero rows |
| ND-1 B: malformed 200 body | `settings_read_malformed`; event unfanned; zero rows |
| ND-1 C: healthy run after | events fan out; following contact: no confirmation (default off), exactly `w1`; custom contact: confirmation + `d1`; repeat run adds nothing |
| ND-1 D: settings read fails at dispatch | run reports a dispatch error; row stays `claimed` with a lease, `skip_reason` null; zero mail |
| ND-1 E: custom contact during the same outage | its reminder sends (`accepted`), one mail: no defaults read needed |
| ND-1 F: lease expired + read recovered | reclaimed and `accepted` once; one mail |
| ND-1 G: default changed after scheduling, successful fresh read | `skipped / opted_out`, no mail |
| ND-1 H: demo ten days out with a 14-day default | one `skipped / due_before_scheduling` row (never sent), `d3` pending, second run adds nothing |
| ND-3: viewer / other retailer / unrelated save / defaults save | refused, refused, preserved, preserved |

Combined build (`e8d0148`) regression: `notification_worker` 86/86, `local_time` 132/132, `store_contact_notifications` 117/117, `owner_directory.smoke` 61/61, `route_flows` 191/191, `lead_time_enforcement` 14/14, `lead_time_setting` 12/12, `retailer_approval` 33/33, `retailer_gate.smoke` 10/10, `launch_flags` 70/70, `npm run check` clean.

## Cutover (not performed; separate authorization)

1. Codex verdict on this packet.
2. David runs the guarded 0088 paste on demohub-prod; expected verify row: ledger `0083,0084,0086,0087,0088`, type `jsonb`, stores with defaults 0.
3. "deploy": merge `e8d0148` into `main`. No env change; `NOTIFICATION_WORKER_ENABLED` stays as it is in Production.
4. On the deployed build: David opens Gus → Team → saves the defaults he wants; the card reloads the saved values and the follower/custom counts; owner mirror shows the same words. Then verify the actual schedule against the real booking (Oct 13, 3:00 PM, Mission Market) and Gus's contact scope: expected pending rows per following contact for each selected offset whose send time is still ahead (7-day → Oct 6 around 9 am, 3-day → Oct 10, morning-of → Oct 13 around 7 am; 14-day already past → one `due_before_scheduling` row, not sent). No deliveries are forced due for testing.
