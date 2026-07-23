-- Migration: add needs_electricity flag to brands table
-- Run this in Supabase SQL editor before shipping the electricity checkbox

ALTER TABLE brands ADD COLUMN IF NOT EXISTS needs_electricity boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN brands.needs_electricity IS 'Brand-set default indicating whether their demos require an electrical outlet at the location. Shown to retailers on every booking.';
