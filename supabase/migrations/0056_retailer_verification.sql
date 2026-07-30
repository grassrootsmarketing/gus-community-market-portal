-- 0056_retailer_verification.sql
-- ============================================================================
-- LAUNCH BLOCKER on retailer onboarding, found by the Step 4 flow tests:
--   column retailers.verification_status does not exist          (42703)
--   Could not find the 'verification_notes' column of 'retailers' (PGRST204)
--
-- api/admin-auth.js implements the entire owner approval workflow against four
-- columns that public.retailers does not have:
--
--   owner-verification-queue   SELECT ... verification_status, verified_at,
--                              verified_by, verification_notes
--                              WHERE verification_status = eq.<status>
--   owner-verify-retailer      PATCH { verification_status, verification_notes,
--                                      verified_at, verified_by }
--
-- Both handlers wrap the call in try/catch and return HTTP 500 "Query failed" /
-- "Update failed". So the owner panel does not appear broken in a way that points
-- at a schema problem — it just never works, and the message says nothing useful.
--
-- CONSEQUENCE: no retailer can be approved, rejected or suspended. For a launch whose
-- whole shape is "admit a controlled cohort", the admission control is the product.
--
-- DIFFERENT SURFACE FROM 0054/0055, SAME SHAPE. Those two were SQL referencing missing
-- columns inside PL/pgSQL bodies. This is JAVASCRIPT referencing missing columns through
-- PostgREST. tools/check-sql-columns.mjs cannot see it, because there is no SQL to read —
-- the column names only exist inside JS string literals. tools/check-js-columns.mjs is
-- added alongside this migration to close that gap.
--
-- DEFAULT 'pending', NOT NULL: a retailer that has not been reviewed must read as
-- pending rather than NULL, so the owner queue's `WHERE verification_status = 'pending'`
-- returns every unreviewed retailer including the ones that already existed. A nullable
-- column would silently hide pre-existing retailers from the very queue meant to catch
-- them — the failure would be an empty list, which looks like "nothing to do".
--
-- CHECK constraint: the handler already validates against exactly these four values.
-- Putting the same domain in the database means a direct SQL write cannot introduce a
-- fifth state that the UI has no branch for.
--
-- Idempotent.
-- ============================================================================

begin;

alter table public.retailers add column if not exists verification_status text not null default 'pending';
alter table public.retailers add column if not exists verified_at        timestamptz;
alter table public.retailers add column if not exists verified_by        text;
alter table public.retailers add column if not exists verification_notes text;

-- Closed domain, matching the handler's own allowlist.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'retailers_verification_status_chk') then
    alter table public.retailers
      add constraint retailers_verification_status_chk
      check (verification_status in ('pending', 'approved', 'rejected', 'suspended'));
  end if;
end $$;

-- The owner queue filters on status and orders by created_at desc. Partial index on the
-- statuses that are actually queued for human attention: approved is the steady state and
-- would dominate the index without being what anyone looks up.
create index if not exists retailers_verification_status_idx
  on public.retailers (verification_status, created_at desc)
  where verification_status in ('pending', 'rejected', 'suspended');

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: run the queries the handlers run.
--
-- Asserting the columns exist would pass even if the CHECK constraint rejected the
-- values the handler actually sends. This performs the real filter and the real patch.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rid uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_status text;
  v_n int;
begin
  insert into retailers (slug, name, billing_email, billing_tier, billing_status)
  values (v_slug, 'verification probe', v_slug || '@invalid.test', 'solo', 'active')
  returning id into v_rid;

  -- A brand-new retailer must land in the queue, not outside it.
  select verification_status into v_status from retailers where id = v_rid;
  if v_status is distinct from 'pending' then
    raise exception 'POST-CONDITION FAILED: a new retailer defaults to %, not pending', coalesce(v_status, '<null>');
  end if;

  -- owner-verification-queue
  select count(*) into v_n from retailers
   where verification_status = 'pending' and id = v_rid;
  if v_n <> 1 then
    raise exception 'POST-CONDITION FAILED: the pending queue does not return a new retailer';
  end if;

  -- owner-verify-retailer, each transition the handler permits
  begin
    update retailers set verification_status = 'approved', verification_notes = 'probe',
                         verified_at = now(), verified_by = 'probe@invalid.test'
     where id = v_rid;
    update retailers set verification_status = 'rejected'  where id = v_rid;
    update retailers set verification_status = 'suspended' where id = v_rid;
    update retailers set verification_status = 'pending', verified_at = null, verified_by = null
     where id = v_rid;
  exception when others then
    raise exception 'POST-CONDITION FAILED: a permitted status transition errored (% / %)', sqlstate, sqlerrm;
  end;

  -- A value outside the handler's allowlist must be refused by the database too.
  begin
    update retailers set verification_status = 'not_a_real_status' where id = v_rid;
    raise exception 'POST-CONDITION FAILED: the CHECK constraint accepted an unknown status';
  exception
    when check_violation then null;                      -- expected
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on invalid status (% / %)', sqlstate, sqlerrm;
  end;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'retailers verification: executed post-conditions passed (queue filter, all four transitions, invalid rejected); probe rolled back';
    else
      raise;
    end if;
end $$;
