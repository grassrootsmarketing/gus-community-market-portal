-- ============================================================================
-- Demohub — P0-1 audit queries (READ-ONLY report first; revoke only after review)
-- ============================================================================

-- (A) ORPHANED-SESSION REPORT (run on staging now; on prod as part of cutover).
--     Retailer admin sessions whose (retailer_id, normalized email) no longer has a
--     LIVE membership. These are already denied at request time by every consumer, but
--     should be explicitly revoked. REVIEW before deleting: platform-owner/support
--     sessions may legitimately have no retailer_admins row — exclude them first.
SELECT s.session_id, s.retailer_id, s.email, s.expires_at
FROM admin_sessions s
WHERE s.retailer_id IS NOT NULL
  AND s.expires_at > now()
  AND NOT EXISTS (
    SELECT 1 FROM retailer_admins ra
    WHERE ra.retailer_id = s.retailer_id
      AND ra.email_normalized = lower(btrim(s.email))
  );

-- (A2) After reviewing (A) and confirming none are owner/support sessions, revoke:
-- DELETE FROM admin_sessions s
-- WHERE s.retailer_id IS NOT NULL
--   AND s.expires_at > now()
--   AND NOT EXISTS (SELECT 1 FROM retailer_admins ra
--                   WHERE ra.retailer_id = s.retailer_id
--                     AND ra.email_normalized = lower(btrim(s.email)));
-- Also revoke unconsumed tokens with no live membership:
-- DELETE FROM admin_tokens t
-- WHERE (t.used_at IS NULL) AND t.retailer_id IS NOT NULL
--   AND NOT EXISTS (SELECT 1 FROM retailer_admins ra
--                   WHERE ra.retailer_id = t.retailer_id
--                     AND ra.email_normalized = lower(btrim(t.email)));

-- ============================================================================
-- (B) PRODUCTION DUPLICATE PREFLIGHT — run on PRODUCTION *before* applying 0025.
--     0025 collapses (retailer_id, email_normalized) duplicates keeping the highest
--     privilege. If ANY normalized identity has CONFLICTING roles/scopes, STOP and
--     resolve manually — do NOT let 0025 silently pick. Expect 0 rows to proceed.
-- ============================================================================
WITH norm AS (
  SELECT id, retailer_id, email, lower(btrim(email)) AS en, lower(btrim(role)) AS role, venue_ids, created_at
  FROM retailer_admins
),
conflicts AS (
  SELECT retailer_id, en,
         count(*) AS rows,
         count(DISTINCT role) AS distinct_roles,
         count(DISTINCT coalesce(array_to_string(venue_ids, ','), '')) AS distinct_scopes
  FROM norm
  GROUP BY retailer_id, en
  HAVING count(*) > 1
)
SELECT n.retailer_id, n.en, n.role, n.venue_ids, n.id, n.created_at
FROM norm n
JOIN conflicts c ON c.retailer_id = n.retailer_id AND c.en = n.en
WHERE c.distinct_roles > 1 OR c.distinct_scopes > 1
ORDER BY n.retailer_id, n.en, n.role;

-- (B2) Role anomaly inventory before 0027 canonicalization (prod): expect to review any
--      null/blank/editor/unknown roles before they are auto-mapped to viewer.
-- SELECT id, retailer_id, email, role FROM retailer_admins
-- WHERE role IS NULL OR btrim(role)='' OR lower(btrim(role)) NOT IN ('owner','admin','manager','viewer');
