-- 0052_venue_limit_pro_ceiling.sql
-- ============================================================================
-- Codex finding D: the Pro venue entitlement was internally contradictory.
--
-- THREE SOURCES DISAGREED:
--   pricing/index.html                 Pro = "Unlimited stores"   (the customer contract)
--   migration 0021 enforce_venue_limit  pro = 10
--   application code convention         999  (ADMIN_CAP in admin-auth.js x2,
--                                        the venueCount clamp in signup.js, and the
--                                        comment in admin.js that itself said
--                                        "Pro (limit=999)")
--
-- So a Pro customer promised unlimited locations would have been refused at number 11
-- by the database trigger. Repairing the JS helper alone (which is what the previous
-- change did) removed the permanent 503 but left that cliff in place — the failure
-- simply moved from "always" to "at 11", which is worse because it looks like it works.
--
-- RESOLUTION per Codex: one reviewed practical-unlimited ceiling, using the existing
-- 999 convention. Solo stays 1. The trigger remains the concurrency-safe authority;
-- api/admin.js's TIER_LIMITS is updated to the same numbers in the same commit.
--
-- NOT a pricing change: 999 locations is a practical stand-in for "unlimited", chosen
-- to match the convention already present in three other places rather than inventing
-- a fourth number. If the advertised contract ever becomes a real hard cap, it changes
-- here and in api/admin.js together.
--
-- 'enterprise' is retained at 1000 as an above-Pro safety ceiling even though the
-- pricing page currently sells only Solo and Pro; the tier is billing-assigned, not
-- self-selectable, so leaving it defined costs nothing and removing it could break an
-- existing assignment.
--
-- Idempotent: CREATE OR REPLACE.
-- ============================================================================

begin;

create or replace function enforce_venue_limit() returns trigger as $$
declare
  v_tier   text;
  v_status text;
  v_limit  int;
  v_count  int;
begin
  -- Serialize concurrent inserts for the same tenant. This is why the trigger, not the
  -- JS pre-check, is authoritative: two simultaneous requests cannot both pass a
  -- count-then-insert check in the application.
  perform 1 from retailers where id = new.retailer_id for update;

  -- Legacy precedence, unchanged from 0021: settings.billing_tier first, then
  -- retailers.billing_tier, defaulting to the most restrictive tier.
  select lower(billing_tier) into v_tier from settings where retailer_id = new.retailer_id limit 1;
  select lower(billing_status) into v_status from retailers where id = new.retailer_id;
  if v_tier is null then
    select lower(billing_tier) into v_tier from retailers where id = new.retailer_id;
  end if;
  v_tier := coalesce(v_tier, 'solo');

  v_limit := case v_tier
    when 'pro'        then 999    -- CHANGED from 10 (0021). Pricing advertises "Unlimited
                                  -- stores" for Pro; 999 is the practical ceiling already
                                  -- used by ADMIN_CAP and the signup clamp. MUST match
                                  -- TIER_LIMITS in api/admin.js.
    when 'enterprise' then 1000   -- above-Pro safety ceiling; billing-assigned only
    else 1                        -- solo / free / legacy starter+growth / unknown
  end;

  -- An inactive paid subscription drops entitlement back to the Solo limit.
  if v_limit > 1 and v_status in ('canceled','cancelled','unpaid','past_due','incomplete_expired') then
    v_limit := 1;
  end if;

  select count(*) into v_count from venues where retailer_id = new.retailer_id;
  if v_count >= v_limit then
    raise exception 'venue_limit_reached: % plan allows % location(s)', v_tier, v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$ language plpgsql;

-- Re-assert the trigger in case an earlier run dropped it.
drop trigger if exists trg_enforce_venue_limit on venues;
create trigger trg_enforce_venue_limit
  before insert on venues
  for each row execute function enforce_venue_limit();

commit;

-- ---------------------------------------------------------------------------
-- Post-condition: the function body must carry the agreed Pro ceiling, so a future
-- edit that reintroduces 10 fails here rather than at a customer's 11th location.
-- ---------------------------------------------------------------------------
do $$
declare v_src text;
begin
  select prosrc into v_src from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_venue_limit';

  if v_src is null then
    raise exception 'POST-CONDITION FAILED: enforce_venue_limit() does not exist';
  end if;
  if v_src not like '%999%' then
    raise exception 'POST-CONDITION FAILED: Pro ceiling is not 999; JS TIER_LIMITS and this trigger must agree';
  end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_enforce_venue_limit' and not tgisinternal
  ) then
    raise exception 'POST-CONDITION FAILED: trg_enforce_venue_limit is not installed';
  end if;
end $$;
