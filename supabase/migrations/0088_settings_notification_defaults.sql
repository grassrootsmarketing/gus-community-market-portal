-- 0088_settings_notification_defaults.sql
-- ============================================================================
-- Store-wide default demo notifications for store contacts (David, 2026-09-30).
--
-- Until now each store contact carried its own notification_prefs, and the only way to set a store-wide
-- rule was to edit one contact and press "use these settings for all store contacts". The default now lives
-- once per store, on settings.notification_defaults (same JSON shape as internal_contacts.notification_prefs:
-- on_confirmed / on_cancelled / on_rescheduled booleans and a reminders[] of offset keys).
--
-- Reading rule (api/_notification-prefs.js resolveContactPrefs, the ONE reading):
--   contact.notification_prefs set  -> that contact's own settings ("custom");
--   else settings.notification_defaults set -> the store's defaults;
--   else the pre-existing fallback: lifecycle emails on, no reminders (Codex Release A rule kept).
-- A contact "follows the store" by having notification_prefs NULL. Nothing changes for existing rows until
-- a store saves defaults; a store that never does keeps exactly today's behaviour.
--
-- Idempotent.
-- ============================================================================
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS notification_defaults jsonb;
COMMENT ON COLUMN public.settings.notification_defaults IS 'Store-wide default demo notification settings for store contacts whose notification_prefs is NULL. Same shape as internal_contacts.notification_prefs. NULL = not set (fallback: lifecycle on, no reminders).';
