-- 0112_store_calendar_links_corrections.sql
-- ============================================================================
-- Shareable store calendar links, Codex first closure review (2026-10-23), the database half of SC-3 and SC-4.
-- Forward migration: 0111 is already recorded on the test project, so its functions are replaced here, not
-- rewritten there.
--
-- SC-4, lifecycle races. issue and revoke now take a transaction-scoped advisory lock on the scope (retailer plus
-- venue-or-store) before they look, so two concurrent issuances for one scope run one after the other and each
-- gets a deliberate result (the later one wins, the earlier token is retired) instead of a unique-index error.
-- resolve is now ONE statement: the UPDATE that stamps last_used_at carries the active-status predicate, so the
-- authorization decision and the row it returns are the same row at the same instant; a revoke committed a moment
-- earlier means no row, and a revoke waiting on the same row lock sees the stamp afterwards. A read already
-- authorized before a revocation finishes; nothing promises to recall an in-flight response.
--
-- SC-3, the rate budget. A dedicated counter table with a primary key per (bucket, hour) and one function doing
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so concurrent hits never lose an increment and the first hits of
-- an hour never collide. The route keys buckets by a trusted client address and by the HASH of a validated link,
-- never by the raw credential.
-- Idempotent. Touches no row of store_calendar_links. service_role only, as before.
-- ============================================================================

-- ---- SC-4: serialized issue and revoke -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_calendar_link_issue(p_retailer_id uuid, p_venue_id uuid, p_token_hash text, p_email text)
RETURNS public.store_calendar_links LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.store_calendar_links; v_scope uuid;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'token_hash_shape'; END IF;
  IF p_venue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.venues WHERE id = p_venue_id AND retailer_id = p_retailer_id) THEN
    RAISE EXCEPTION 'venue_not_in_retailer';
  END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  -- one scope at a time, for the rest of this transaction
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope;
  INSERT INTO public.store_calendar_links (retailer_id, venue_id, token_hash, issued_by_email)
  VALUES (p_retailer_id, p_venue_id, p_token_hash, p_email) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

CREATE OR REPLACE FUNCTION public.store_calendar_link_revoke(p_retailer_id uuid, p_venue_id uuid, p_email text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int; v_scope uuid;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- ---- SC-4: atomic resolve ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_calendar_link_resolve(p_token_hash text)
RETURNS TABLE (link_id uuid, retailer_id uuid, venue_id uuid, slug text, name text, timezone text, logo_url text, issued_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH hit AS (
    UPDATE public.store_calendar_links l SET last_used_at = now()
     WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND l.token_hash = p_token_hash AND l.revoked_at IS NULL
     RETURNING l.id, l.retailer_id, l.venue_id, l.issued_at
  )
  SELECT h.id, h.retailer_id, h.venue_id, r.slug, r.name, r.timezone, r.logo_url, h.issued_at
    FROM hit h JOIN public.retailers r ON r.id = h.retailer_id;
$$;

REVOKE ALL ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)      FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_resolve(text)                 FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_resolve(text)                 TO service_role;

-- ---- SC-3: an atomic hourly counter ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.store_calendar_rate (
  bucket_key   text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
ALTER TABLE public.store_calendar_rate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_calendar_rate FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.store_calendar_rate TO service_role;

-- One hit on a bucket for the hour that contains p_at: increments atomically and says whether the hit stays within
-- p_max. The count is the value AFTER this hit, so a caller sees exactly p_max allowed hits per hour and the
-- (p_max + 1)th refused, whatever the concurrency.
CREATE OR REPLACE FUNCTION public.store_calendar_rate_hit(p_bucket_key text, p_max integer, p_at timestamptz DEFAULT now())
RETURNS TABLE (allowed boolean, hits integer, window_start timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH w AS (SELECT date_trunc('hour', coalesce(p_at, now())) AS ws),
  up AS (
    INSERT INTO public.store_calendar_rate (bucket_key, window_start, count)
    SELECT p_bucket_key, w.ws, 1 FROM w
    ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = public.store_calendar_rate.count + 1
    RETURNING count, public.store_calendar_rate.window_start
  )
  SELECT (up.count <= p_max) AS allowed, up.count AS hits, up.window_start FROM up;
$$;
REVOKE ALL ON FUNCTION public.store_calendar_rate_hit(text, integer, timestamptz) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_calendar_rate_hit(text, integer, timestamptz) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'store_calendar_link_issue';
  IF v_src IS NULL OR position('pg_advisory_xact_lock' IN v_src) = 0 THEN RAISE EXCEPTION '0112 postcondition: issue does not take the scope lock'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'store_calendar_link_revoke';
  IF v_src IS NULL OR position('pg_advisory_xact_lock' IN v_src) = 0 THEN RAISE EXCEPTION '0112 postcondition: revoke does not take the scope lock'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'store_calendar_link_resolve';
  IF v_src IS NULL OR position('revoked_at IS NULL' IN v_src) = 0 OR position('UPDATE' IN v_src) = 0 THEN RAISE EXCEPTION '0112 postcondition: resolve is not the single-statement form'; END IF;
  IF to_regclass('public.store_calendar_rate') IS NULL THEN RAISE EXCEPTION '0112 postcondition: store_calendar_rate is absent'; END IF;
  IF has_function_privilege('anon', 'public.store_calendar_rate_hit(text, integer, timestamptz)', 'EXECUTE') THEN RAISE EXCEPTION '0112 postcondition: anon can execute rate_hit'; END IF;
  IF has_function_privilege('anon', 'public.store_calendar_link_resolve(text)', 'EXECUTE') THEN RAISE EXCEPTION '0112 postcondition: anon can execute resolve'; END IF;
END $$;
