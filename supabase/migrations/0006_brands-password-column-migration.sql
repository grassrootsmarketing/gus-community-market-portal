-- Adds the password_hash column the P8 brand-account password system needs.
-- Without this, booking-signup / set-password / login-password all fail.
-- Run this ONCE in Supabase SQL editor.

ALTER TABLE brands ADD COLUMN IF NOT EXISTS password_hash TEXT;
