-- ==========================================================================
-- Migration: enforce single-profile-per-email
-- Adds unique indexes so one email can only own one retailer OR one brand,
-- and never both. Backend collision checks already ship friendly errors,
-- but these indexes are the last line of defense against race conditions.
-- ==========================================================================

-- STEP 1 — Look at existing duplicates before applying the constraint.
-- (Run this FIRST. If it returns rows, you need to consolidate/delete
-- duplicate retailers or brands manually. Otherwise Step 2 will fail.)

SELECT
    'retailer' AS type,
    LOWER(billing_email) AS email,
    COUNT(*) AS accounts,
    STRING_AGG(slug, ', ') AS slugs
FROM retailers
WHERE billing_email IS NOT NULL AND billing_email != ''
GROUP BY LOWER(billing_email)
HAVING COUNT(*) > 1
UNION ALL
SELECT
    'brand' AS type,
    LOWER(email) AS email,
    COUNT(*) AS accounts,
    STRING_AGG(company_name, ', ') AS slugs
FROM brands
WHERE email IS NOT NULL AND email != ''
GROUP BY LOWER(email)
HAVING COUNT(*) > 1
UNION ALL
-- Cross-role collisions (same email exists as BOTH retailer and brand)
SELECT
    'cross_role' AS type,
    LOWER(r.billing_email) AS email,
    2 AS accounts,
    r.slug || ' | ' || b.company_name AS slugs
FROM retailers r
JOIN brands b ON LOWER(b.email) = LOWER(r.billing_email)
WHERE r.billing_email IS NOT NULL AND r.billing_email != '';

-- ==========================================================================
-- STEP 2 — Normalize existing emails to lowercase.
-- Safe to run repeatedly.

UPDATE retailers
SET billing_email = LOWER(TRIM(billing_email))
WHERE billing_email IS NOT NULL
  AND billing_email != LOWER(TRIM(billing_email));

UPDATE brands
SET email = LOWER(TRIM(email))
WHERE email IS NOT NULL
  AND email != LOWER(TRIM(email));

-- ==========================================================================
-- STEP 3 — Add unique indexes.
-- These will FAIL if Step 1 returned any duplicates. Clean up first.

CREATE UNIQUE INDEX IF NOT EXISTS retailers_billing_email_unique
    ON retailers (LOWER(billing_email))
    WHERE billing_email IS NOT NULL AND billing_email != '';

CREATE UNIQUE INDEX IF NOT EXISTS brands_email_unique
    ON brands (LOWER(email))
    WHERE email IS NOT NULL AND email != '';

-- ==========================================================================
-- STEP 4 (optional) — Cross-role enforcement at DB level.
-- The backend already rejects cross-role, but if you want a hard guarantee,
-- add a check trigger. This is more expensive to write and maintain than
-- the app-level check, so it's OPTIONAL. Not shipped by default.

-- CREATE OR REPLACE FUNCTION check_no_cross_role_email() RETURNS trigger AS $$
-- BEGIN
--     IF TG_TABLE_NAME = 'retailers' THEN
--         IF EXISTS (SELECT 1 FROM brands WHERE LOWER(email) = LOWER(NEW.billing_email)) THEN
--             RAISE EXCEPTION 'Email % is already registered as a brand', NEW.billing_email;
--         END IF;
--     ELSIF TG_TABLE_NAME = 'brands' THEN
--         IF EXISTS (SELECT 1 FROM retailers WHERE LOWER(billing_email) = LOWER(NEW.email)) THEN
--             RAISE EXCEPTION 'Email % is already registered as a retailer', NEW.email;
--         END IF;
--     END IF;
--     RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- CREATE TRIGGER retailers_no_cross_role
--     BEFORE INSERT OR UPDATE OF billing_email ON retailers
--     FOR EACH ROW EXECUTE FUNCTION check_no_cross_role_email();
--
-- CREATE TRIGGER brands_no_cross_role
--     BEFORE INSERT OR UPDATE OF email ON brands
--     FOR EACH ROW EXECUTE FUNCTION check_no_cross_role_email();
