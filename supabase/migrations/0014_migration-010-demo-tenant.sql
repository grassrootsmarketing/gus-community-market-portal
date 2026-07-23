-- Migration 010: Add is_demo flag to retailers for Phase C (live demo tenant)
-- Idempotent: safe to run multiple times.

ALTER TABLE retailers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT FALSE NOT NULL;

-- Index for the demo tenant lookup in /api/admin (Phase C read-only gate).
CREATE INDEX IF NOT EXISTS idx_retailers_is_demo ON retailers (is_demo) WHERE is_demo = TRUE;
