-- 0111_store_calendar_links.sql
-- ============================================================================
-- Shareable store calendar links (David, Codex design review 2026-10-23): a view-only calendar page per store
-- (and per location) that floor staff open from a link, with no account and no profile. The link is a bearer
-- credential; this migration gives it a home that is scoped server-side and revocable.
--
-- One row per issued link. The plaintext token is never stored: the route hashes what the visitor presents
-- (sha256, hex) and looks the hash up, so a copy of this table does not reveal a usable link. The link is shown
-- to the admin once, at issue or rotation; "copy it again later" is a rotation.
--
-- Scope is bound here, never derived from a client parameter: venue_id NULL means the whole store, a venue id
-- means that one location only (and it must belong to the retailer). At most one ACTIVE link per scope; issuing
-- a link for a scope revokes that scope's previous link in the same statement (atomic rotation). Rotating one
-- location's link touches no other location and nothing of the legacy iCal feed (retailers.cal_feed_key).
--
-- Resolution grants calendar READ for the scope and nothing else: these rows are never a session, a login or a
-- booking credential, and the functions are callable by service_role only (the route authorizes the admin
-- before it calls issue).
-- Forward-only. Idempotent. Touches no existing row or object.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.store_calendar_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id      uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
  venue_id         uuid REFERENCES public.venues(id) ON DELETE CASCADE,   -- NULL = the whole store
  token_hash       text NOT NULL UNIQUE,                                   -- sha256 hex of the presented token
  issued_at        timestamptz NOT NULL DEFAULT now(),
  issued_by_email  text,
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  revoked_by_email text,
  CONSTRAINT store_calendar_links_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
-- One active link per scope (NULL venue folded to a fixed uuid so the partial unique index can see it).
CREATE UNIQUE INDEX IF NOT EXISTS store_calendar_links_one_active_per_scope
  ON public.store_calendar_links (retailer_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS store_calendar_links_retailer_idx ON public.store_calendar_links (retailer_id) WHERE revoked_at IS NULL;
ALTER TABLE public.store_calendar_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_calendar_links FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.store_calendar_links TO service_role;

-- Issue (or rotate) the link for one scope. Revokes the scope's active link and inserts the new one in one
-- statement, so there is never a moment with two active links or none. The venue must belong to the retailer.
CREATE OR REPLACE FUNCTION public.store_calendar_link_issue(p_retailer_id uuid, p_venue_id uuid, p_token_hash text, p_email text)
RETURNS public.store_calendar_links LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.store_calendar_links;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'token_hash_shape'; END IF;
  IF p_venue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.venues WHERE id = p_venue_id AND retailer_id = p_retailer_id) THEN
    RAISE EXCEPTION 'venue_not_in_retailer';
  END IF;
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  INSERT INTO public.store_calendar_links (retailer_id, venue_id, token_hash, issued_by_email)
  VALUES (p_retailer_id, p_venue_id, p_token_hash, p_email) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Revoke one scope's active link without issuing a new one (the "stop sharing this" button).
CREATE OR REPLACE FUNCTION public.store_calendar_link_revoke(p_retailer_id uuid, p_venue_id uuid, p_email text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

-- Resolve a presented token (by hash) to its scope. Nothing for unknown or revoked hashes. Stamps last_used_at
-- so an operator can see a link still being opened after it should have been retired. Returns the few store
-- facts the page header needs; no contact, billing or policy fields.
CREATE OR REPLACE FUNCTION public.store_calendar_link_resolve(p_token_hash text)
RETURNS TABLE (link_id uuid, retailer_id uuid, venue_id uuid, slug text, name text, timezone text, logo_url text, issued_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT l.id INTO v_id FROM public.store_calendar_links l WHERE l.token_hash = p_token_hash AND l.revoked_at IS NULL;
  IF v_id IS NULL THEN RETURN; END IF;
  UPDATE public.store_calendar_links SET last_used_at = now() WHERE id = v_id;
  RETURN QUERY
    SELECT l.id, l.retailer_id, l.venue_id, r.slug, r.name, r.timezone, r.logo_url, l.issued_at
      FROM public.store_calendar_links l JOIN public.retailers r ON r.id = l.retailer_id
     WHERE l.id = v_id;
END $$;

REVOKE ALL ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)      FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_resolve(text)                 FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_resolve(text)                 TO service_role;

-- Post-conditions (literal-only).
DO $$
BEGIN
  IF to_regclass('public.store_calendar_links') IS NULL THEN RAISE EXCEPTION '0111 postcondition: store_calendar_links is absent'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'store_calendar_links_one_active_per_scope') THEN RAISE EXCEPTION '0111 postcondition: one-active-per-scope index is absent'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_link_resolve')) <> 3 THEN RAISE EXCEPTION '0111 postcondition: the three link functions are not all present'; END IF;
  IF has_function_privilege('anon', 'public.store_calendar_link_resolve(text)', 'EXECUTE') THEN RAISE EXCEPTION '0111 postcondition: anon can execute resolve'; END IF;
  IF has_table_privilege('anon', 'public.store_calendar_links', 'SELECT') THEN RAISE EXCEPTION '0111 postcondition: anon can read the links table'; END IF;
END $$;
