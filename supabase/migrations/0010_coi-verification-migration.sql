-- COI content verification. Run ONCE in the Supabase SQL editor.
-- Additive and idempotent. Safe on existing rows.

-- 1) Quick-read status on the brand (passed | flagged | pending).
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS coi_verification_status text;

-- 2) Audit trail of every verification, so the retailer can see what was extracted
--    and you can review decisions later.
CREATE TABLE IF NOT EXISTS coi_verifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id             uuid REFERENCES brands(id) ON DELETE CASCADE,
  coi_url              text,
  status               text,          -- passed | flagged | pending
  confidence           numeric,
  is_coi               boolean,
  insured_name         text,
  insurer_name         text,
  insurer_naic         text,
  policy_expiry        date,
  gl_each_occurrence   numeric,
  gl_general_aggregate numeric,
  flags                jsonb DEFAULT '[]'::jsonb,
  raw                  jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coi_verifications_brand ON coi_verifications (brand_id, created_at DESC);

-- Verify (optional):
-- SELECT column_name FROM information_schema.columns WHERE table_name='coi_verifications';
