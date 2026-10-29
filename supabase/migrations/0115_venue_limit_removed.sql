-- 0115_venue_limit_removed.sql
-- ============================================================================
-- Pricing change of 2026-10-28: Demohub is free for retailers at any number of locations, and the Pro tier is gone.
-- The per-plan location limit goes with it. This file removes the trigger that enforced it, trg_enforce_venue_limit on
-- venues (0021, revised in 0052 and 0054), and its function enforce_venue_limit(). The code paths that mirrored the
-- limit (api/admin.js venue create, api/venues-bulk-import.js precheck, the team-invite gate in api/admin-auth.js) are
-- removed in the same release.
-- retailers.billing_tier and retailers.billing_status remain as columns. Rows still carry whatever value they have;
-- nothing reads them to refuse a write any more.
-- Forward-only. Idempotent (DROP ... IF EXISTS). No row is changed.
-- ============================================================================

drop trigger if exists trg_enforce_venue_limit on public.venues;
drop function if exists public.enforce_venue_limit();

-- ---------------------------------------------------------------------------
-- POST-CONDITION, executed rather than read: a retailer whose tier still says 'solo' takes three locations in a row.
-- Everything below runs inside a block that always rolls back, so the probe leaves no row behind.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rid   uuid;
  v_slug  text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_count int;
begin
  if exists (select 1 from pg_trigger where tgname = 'trg_enforce_venue_limit' and not tgisinternal) then
    raise exception 'POST-CONDITION FAILED: trg_enforce_venue_limit still exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname = 'enforce_venue_limit') then
    raise exception 'POST-CONDITION FAILED: enforce_venue_limit() still exists';
  end if;

  insert into retailers (slug, name, billing_email, billing_tier, billing_status)
  values (v_slug, 'post-condition probe', v_slug || '@invalid.test', 'solo', 'active')
  returning id into v_rid;

  for i in 1..3 loop
    begin
      insert into venues (retailer_id, name, address) values (v_rid, 'probe ' || i, i || ' Probe St');
    exception when others then
      raise exception 'POST-CONDITION FAILED: a solo retailer was refused location % (% / %)', i, sqlstate, sqlerrm;
    end;
  end loop;

  select count(*) into v_count from venues where retailer_id = v_rid;
  if v_count <> 3 then
    raise exception 'POST-CONDITION FAILED: expected 3 locations, found %', v_count;
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice '0115: executed post-conditions passed (solo retailer took 3 locations); probe rolled back';
    else
      raise;
    end if;
end $$;
