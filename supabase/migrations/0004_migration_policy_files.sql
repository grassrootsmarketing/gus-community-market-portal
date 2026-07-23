-- ==========================================================================
-- Migration: policy file upload support
-- Adds columns to store uploaded PDF URLs alongside the existing text policies,
-- and snapshot columns on brand_retailer_agreements to preserve the exact file
-- the brand signed against (URL-snapshot approach).
-- ==========================================================================

-- 1) Retailers: URL + filename for uploaded PDFs
ALTER TABLE retailers
    ADD COLUMN IF NOT EXISTS cancellation_policy_url TEXT,
    ADD COLUMN IF NOT EXISTS cancellation_policy_filename TEXT,
    ADD COLUMN IF NOT EXISTS demo_policy_url TEXT,
    ADD COLUMN IF NOT EXISTS demo_policy_filename TEXT;

COMMENT ON COLUMN retailers.cancellation_policy_url IS 'Optional PDF replacement for text policy. When set, brands see the PDF instead of cancellation_policy text.';
COMMENT ON COLUMN retailers.demo_policy_url IS 'Optional PDF replacement for text policy. When set, brands see the PDF instead of demo_policy text.';

-- 2) Brand-retailer agreements: snapshot the URL at signing time
ALTER TABLE brand_retailer_agreements
    ADD COLUMN IF NOT EXISTS cancellation_policy_url_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS demo_policy_url_snapshot TEXT;

COMMENT ON COLUMN brand_retailer_agreements.cancellation_policy_url_snapshot IS 'If retailer had a PDF policy uploaded at signing, this is that URL frozen in time. Prevents disputes when retailer later replaces the file.';
COMMENT ON COLUMN brand_retailer_agreements.demo_policy_url_snapshot IS 'Same as cancellation_policy_url_snapshot but for demo policy.';

-- 3) Storage bucket (run in Supabase Storage tab if not using API):
-- Create a public bucket named 'policy-docs' with these settings:
--   - Public: yes (brands need to view without auth)
--   - Allowed MIME types: application/pdf, image/png, image/jpeg
--   - Max file size: 5 MB
--
-- Or if you prefer SQL (works in Supabase):
-- INSERT INTO storage.buckets (id, name, public) VALUES ('policy-docs', 'policy-docs', true) ON CONFLICT DO NOTHING;
