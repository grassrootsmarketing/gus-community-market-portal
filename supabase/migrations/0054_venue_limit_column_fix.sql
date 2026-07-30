-- 0054_venue_limit_column_fix.sql
-- ============================================================================
-- LAUNCH BLOCKER, found by the Step 4 valid-binding tests: every venue INSERT
-- fails with 42703 "column billing_tier does not exist".
--
-- enforce_venue_limit() begins:
--     select lower(billing_tier) into v_tier from settings where retailer_id = ... ;
-- and public.settings has no billing_tier column. It has exactly eight:
-- id, retailer_id, demo_fee, demo_duration, advance_booking_days, custom,
-- created_at, updated_at. No migration in the chain adds one.
--
-- The reference came in with 0021 and 0052 carried it forward verbatim, under a
-- comment describing "legacy precedence: settings.billing_tier first". That
-- precedence was fiction. The first lookup could never have succeeded; it raised
-- before reaching the fallback.
--
-- WHY THIS SURVIVED EVERY EXISTING CHECK
--   * PL/pgSQL does not resolve identifiers in a function body at CREATE time.
--     The body is parsed, not bound. The migration therefore applies cleanly and
--     reports success while containing a reference that cannot resolve.
--   * Both clean builds were green, and their manifests matched, because the
--     function was created identically — identically broken — in each.
--   * 0052's post-condition asserted that prosrc LIKE '%999%'. That inspects the
--     TEXT of the function. A function's text is not evidence that it runs.
--   * The one route that creates venues (/api/admin) returned 503 unconditionally
--     until this round, so nothing ever executed the trigger.
--
-- Five layers of verification and none of them ran the code. That is the finding
-- underneath the finding.
--
-- THE FIX: read the tier from retailers only, which is where it actually lives.
-- Behaviour is otherwise identical to 0052 — Solo 1, Pro 999, Enterprise 1000,
-- lapsed paid subscriptions dropped to the Solo limit, FOR UPDATE serialisation
-- retained so concurrent inserts cannot both pass a count check.
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
  -- Serialise concurrent inserts for this tenant. This is why the trigger, and not
  -- an application-side count, is authoritative: two simultaneous requests cannot
  -- both pass a count-then-insert check in JS.
  perform 1 from retailers where id = new.retailer_id for update;

  -- Tier comes from retailers. The former settings lookup is removed rather than
  -- guarded, because the column does not exist and never did — keeping a lookup
  -- that cannot resolve would preserve the defect behind a null check.
  select lower(billing_tier), lower(billing_status)
    into v_tier, v_status
    from retailers where id = new.retailer_id;

  v_tier := coalesce(v_tier, 'solo');

  v_limit := case v_tier
    when 'pro'        then 999    -- practical "unlimited"; MUST match TIER_LIMITS in api/admin.js
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

drop trigger if exists trg_enforce_venue_limit on venues;
create trigger trg_enforce_venue_limit
  before insert on venues
  for each row execute function enforce_venue_limit();

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: EXECUTE the trigger, do not read its source.
--
-- This is the part 0052 got wrong. Everything below actually inserts rows and
-- inspects the outcome, inside a block that always rolls back, so a function that
-- compiles but cannot run fails the migration instead of shipping.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rid uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_err  text;
  v_count int;
begin
  -- Solo: first insert must succeed, second must be refused.
  insert into retailers (slug, name, billing_email, billing_tier, billing_status)
  values (v_slug, 'post-condition probe', v_slug || '@invalid.test', 'solo', 'active')
  returning id into v_rid;

  begin
    insert into venues (retailer_id, name, address) values (v_rid, 'probe 1', '1 Probe St');
  exception when others then
    raise exception 'POST-CONDITION FAILED: the FIRST venue insert errored (%): %', sqlstate, sqlerrm;
  end;

  begin
    insert into venues (retailer_id, name, address) values (v_rid, 'probe 2', '2 Probe St');
    raise exception 'POST-CONDITION FAILED: a Solo retailer accepted a SECOND location';
  exception
    when check_violation then null;                      -- expected
    when others then
      get stacked diagnostics v_err = message_text;
      if v_err like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: second insert raised % (%) instead of venue_limit_reached', sqlstate, sqlerrm;
  end;

  select count(*) into v_count from venues where retailer_id = v_rid;
  if v_count <> 1 then
    raise exception 'POST-CONDITION FAILED: expected exactly 1 venue, found %', v_count;
  end if;

  -- Pro: the 11th location must be accepted. 0052 capped Pro at 10, so this is the
  -- assertion that would have caught that cliff at the customer's 11th store.
  update retailers set billing_tier = 'pro' where id = v_rid;
  for i in 2..11 loop
    begin
      insert into venues (retailer_id, name, address) values (v_rid, 'probe ' || i, i || ' Probe St');
    exception when others then
      raise exception 'POST-CONDITION FAILED: Pro refused location % (% / %)', i, sqlstate, sqlerrm;
    end;
  end loop;

  select count(*) into v_count from venues where retailer_id = v_rid;
  if v_count <> 11 then
    raise exception 'POST-CONDITION FAILED: Pro expected 11 locations, found %', v_count;
  end if;

  -- Always undo the probe. Raising here is what rolls the DO block back; the
  -- exception is caught immediately and swallowed so the migration succeeds.
  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'enforce_venue_limit(): executed post-conditions passed (Solo=1, Pro=11 accepted); probe rolled back';
    else
      raise;
    end if;
end $$;
