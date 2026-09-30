# Demohub store default demo notifications: pre-deploy handoff for Codex (2026-09-30)

Branch `feat/notification-defaults` @ **`b425b24`** (one commit on production `main` @ `3516f76`). Not deployed. Migration 0088 applied on demohub-rebuild-check only. Production unchanged.

## Why

Gus's first demo is about ten days out and David went looking for team reminders. He found them buried in each store contact's edit form, per person, with a "use these settings for all store contacts" button as the only store-wide control. Worse, contacts added before reminders existed carry NULL prefs, which the Release A rule reads as "lifecycle emails on, no reminders", so most of Gus's contacts would have received no reminders. David's brief: one store-wide default (email only) with 14 days, 7 days, 3 days and the morning of as the options; each contact follows it unless overridden.

## Design

- **Migration `0088_settings_notification_defaults.sql`**: `settings.notification_defaults jsonb` (nullable), same shape as `internal_contacts.notification_prefs`. Column comment states the rule. No data change; nothing changes for any store until it saves a default.
- **One reading rule** in `api/_notification-prefs.js`: `resolveContactPrefs(contactRaw, storeDefaultsRaw)` returns `{prefs, source}`:
  - contact prefs set (non-empty object) → `custom`, contact's own values;
  - else store default set → `store`;
  - else → `fallback` = the unchanged Release A behaviour (lifecycle on, no reminders).
  `prefsAreSet(raw)` defines "set" (plain object with at least one key). Legacy key translation and offset normalisation are unchanged (`normalizePrefs`).
- **Outbox** (`api/_notification-outbox.js`): `loadContactsForRetailer` reads `settings.notification_defaults` once per retailer per run (cache `defaultsByRetailer`; a failed read means "no default", never "no contacts") and resolves each contact; the **send-time re-check** resolves against a fresh read of the store default too, so a following contact tracks later changes (a reminder the default no longer includes is skipped `opted_out`, as before for a contact's own opt-out).
- **Retailer write path** (`api/admin.js`): settings PATCH with `notification_defaults` is validated with the same `validateNotificationPrefs` (400 `invalid_notification_defaults`), stored normalized; `null` clears. The admin data read returns it (viewers too). Contacts: saving a following contact writes `notification_prefs: null` (already allowed; "null clears" was existing behaviour).
- **Retailer admin, Team tab** (`r/gus/admin/index.html`): new "Demo notification defaults" card above the contacts list (lifecycle checkboxes; reminders `d14`, `w1`, `d3`, `morning_of`; Save; status line "N of M store contacts follow these defaults; K have custom settings", and an explicit "Not set yet: ... no reminders" warning until saved). Any reminder offsets outside those four that an older default carried are kept on save, not silently dropped. Contact editor: radio "Follow the store defaults" (shows the store summary) / "Custom for this contact" (reveals the existing controls, plus a new 2-weeks option `d14`); existing contacts open in the mode their row implies; new contacts default to following. The "use these settings for all store contacts" button and its function are removed. Custom contacts are marked in the list.
- **Owner mirror** (`api/admin-auth.js`, `owner/index.html`): the retailer profile shows the store default in words (or "Not set: contacts get demo emails and no reminders until the store saves defaults") and tags each contact "store default" / "custom for this contact" / "no store default set", with the resolved reminders.

Copy states email only and the send times (9 am store time for day offsets, 7 am for morning-of), matching `reminderWindow`.

## What it does not do

- No change to who is in scope for a booking (`contactInScope` / `venue_ids`) or to lifecycle semantics.
- No backfill: existing contacts keep NULL prefs and start following the store only when the store saves a default. Contacts with their own saved prefs stay custom until the retailer switches them.
- No per-venue defaults.
- Retailer settings PATCH still has no column allowlist (pre-existing; unrelated columns unchanged by this branch).

## Evidence (observed 2026-09-30, demohub-rebuild-check, mail intercepted, worker flag on in the harness)

`tests/notification_defaults.test.mjs`: **16 passed, 0 failed**.

| Area | Asserted |
|---|---|
| Pure rule | custom beats store; NULL follows store; `{}` counts as not set; no default → fallback (lifecycle on, no reminders) |
| Write path | invalid default → 400 `invalid_notification_defaults`; valid default stored normalized (duplicate `w1` collapsed, sorted `d14,w1,morning_of`, lifecycle explicit); admin data read returns it |
| Scheduler | confirmed booking 20 days out, worker run: the NULL-prefs contact gets `d14`, `w1`, `morning_of` reminder rows; the custom contact keeps only its `d1`; both get the confirmed notice |
| Send time | default changed to drop `d14`; the scheduled `d14` row (forced due) is skipped `opted_out`, not sent |
| Owner mirror | store default in words; contacts tagged `store` / `custom` with resolved reminders |
| Clear | `null` clears the default; the following contact reads `fallback`, lifecycle on, no reminders |

Regression, same database: `store_contact_notifications` 117/117, `notification_worker` 86/86, `local_time` (prefs normaliser) 132/132, `owner_directory.smoke` 61/61, `route_flows` 191/191. `npm run check` clean (88 migrations).

Browser (local preview, stubbed data, no console errors): card renders the saved default and the status line; saving sends the expected object; a following contact opens on "Follow the store defaults" with the store summary and the custom controls hidden; a custom contact opens on "Custom" with its own boxes; a new contact opens on "Follow" pre-filled with the store's values; "apply to all" is gone; custom contacts are marked in the list.

## Cutover

1. Codex verdict.
2. David runs the 0088 paste on demohub-prod (one `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` plus a comment and the ledger row; guarded kit to be generated on acceptance, expected ledger tail `0083,0084,0086,0087,0088`; 0085 still absent).
3. "deploy": merge into `main`. This branch will be combined with `fix/lead-time-dropdown` (e25c117, independent Settings fix) at merge time; both touch `api/admin.js` and the admin page in different places.
4. After deploy, David saves Gus's defaults in the Team tab (his choice of the four reminders); the next worker run schedules reminders for the confirmed demo. Rollback: revert the commit; the column may stay.

## Review asks

1. Is "NULL prefs follows the store default" the right semantics given the Release A rule you set (missing prefs → lifecycle on, no reminders)? It is preserved exactly when no default exists.
2. The send-time re-check now does one extra settings read per delivery; acceptable, or cache per run?
3. Anything in the retailer-facing copy you want changed before Gus uses it?
