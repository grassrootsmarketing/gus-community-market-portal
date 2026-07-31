-- 0058_coi_manual_review.sql
-- ============================================================================
-- LAUNCH BLOCKER, named by Codex in the v6 ruling: an uploaded certificate of insurance
-- cannot be approved by anybody.
--
-- THE DEAD END, in four steps, each one individually correct:
--   1. Closed-launch policy keeps COI_AI_VERIFICATION_ENABLED=false until a separate
--      data-processing approval is completed.
--   2. A real upload therefore lands with status 'pending'.
--   3. api/book.js accepts only 'passed' or 'approved'  (api/_coi-policy.js, the canonical
--      rule introduced alongside this migration).
--   4. No application route moves a record from 'pending' to 'approved'.
--
-- So a brand uploads a valid certificate, and nothing anyone can do in the product will let
-- them book. The existing route test concealed this by PATCHing
-- brands.coi_verification_status='passed' directly against the database -- a shortcut that
-- proved the booking gate worked while proving nothing about how a real certificate would
-- ever reach that state. That shortcut is removed in the same change as this migration.
--
-- WHAT THIS ADDS
--   * review columns on coi_verifications: who decided, when, what, and why
--   * review_decision constrained to exactly 'approved' or 'rejected'
--   * an atomic SECURITY DEFINER function that performs the whole review in ONE transaction
--   * EXECUTE granted to service_role only -- the owner route runs as service_role behind an
--     authenticated platform-owner session; anon and authenticated cannot reach it at all
--
-- WHY ONE FUNCTION RATHER THAN TWO UPDATES
--   The review must set coi_verifications.review_decision AND brands.coi_verification_status
--   together or not at all. Two separate PATCHes from a route can interleave with an upload,
--   leaving a brand marked approved while the row describing the approved document has been
--   replaced. That is precisely the stale-approval hole Codex asked to be closed, and it
--   cannot be closed from the application layer.
--
-- THE STALENESS CHECK IS THE POINT
--   Approval is bound to the EXACT document reviewed. If the brand uploaded a replacement
--   after the reviewer opened the record, coi_verifications.coi_url no longer matches
--   brands.default_coi_url, and approving would grant coverage to a document nobody looked
--   at. The function refuses with a distinct error rather than silently approving.
--
-- Rejection retains the record for audit and can never grant coverage: the canonical rule
-- treats anything other than passed/approved as not covered.
--
-- Idempotent.
-- ============================================================================

begin;

alter table public.coi_verifications add column if not exists reviewed_at      timestamptz;
alter table public.coi_verifications add column if not exists reviewed_by      text;
alter table public.coi_verifications add column if not exists review_decision  text;
alter table public.coi_verifications add column if not exists review_notes     text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coi_verifications_review_decision_chk') then
    alter table public.coi_verifications
      add constraint coi_verifications_review_decision_chk
      check (review_decision is null or review_decision in ('approved','rejected'));
  end if;
end $$;

-- Bounded notes. A review note is an operator sentence, not a place to paste a document.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coi_verifications_review_notes_len_chk') then
    alter table public.coi_verifications
      add constraint coi_verifications_review_notes_len_chk
      check (review_notes is null or length(review_notes) <= 2000);
  end if;
end $$;

-- The owner queue reads pending/flagged newest-first. Partial index: reviewed rows are the
-- steady state and would dominate an unfiltered index without being what anyone looks up.
create index if not exists coi_verifications_review_queue_idx
  on public.coi_verifications (created_at desc)
  where review_decision is null;

create index if not exists coi_verifications_brand_created_idx
  on public.coi_verifications (brand_id, created_at desc);

-- ---------------------------------------------------------------------------
-- The atomic review.
-- ---------------------------------------------------------------------------
create or replace function public.review_coi_verification(
  p_verification_id uuid,
  p_decision        text,
  p_reviewer        text,
  p_notes           text default null
) returns public.coi_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.coi_verifications;
  v_brand public.brands;
begin
  if p_decision is null or p_decision not in ('approved','rejected') then
    raise exception 'decision must be approved or rejected' using errcode = 'check_violation';
  end if;
  if p_reviewer is null or btrim(p_reviewer) = '' then
    raise exception 'reviewer is required' using errcode = 'check_violation';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'review notes are limited to 2000 characters' using errcode = 'check_violation';
  end if;

  -- Lock the record so two reviewers cannot decide the same document concurrently.
  select * into v_row from coi_verifications where id = p_verification_id for update;
  if not found then
    raise exception 'verification record not found' using errcode = 'no_data_found';
  end if;
  if v_row.brand_id is null then
    raise exception 'verification record has no brand' using errcode = 'check_violation';
  end if;

  select * into v_brand from brands where id = v_row.brand_id for update;
  if not found then
    raise exception 'brand not found for this verification' using errcode = 'no_data_found';
  end if;

  -- STALENESS. Approval is bound to the exact document reviewed. If a replacement was
  -- uploaded after the reviewer opened this record, approving it would grant coverage to a
  -- document nobody examined.
  if p_decision = 'approved'
     and v_row.coi_url is distinct from v_brand.default_coi_url then
    raise exception 'stale review: this record does not describe the brand''s current certificate'
      using errcode = 'check_violation';
  end if;

  update coi_verifications
     set review_decision = p_decision,
         reviewed_at     = now(),
         reviewed_by     = btrim(p_reviewer),
         review_notes    = p_notes,
         status          = case when p_decision = 'approved' then 'approved' else 'rejected' end
   where id = p_verification_id
  returning * into v_row;

  -- Same transaction. The brand's status and the reviewed record can never disagree.
  update brands
     set coi_verification_status = case when p_decision = 'approved' then 'approved' else 'rejected' end
   where id = v_row.brand_id;

  return v_row;
end $$;

revoke all on function public.review_coi_verification(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.review_coi_verification(uuid, text, text, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: perform real reviews on probe rows, then roll back.
-- Asserting the columns exist would pass even if the CHECK rejected the values the route
-- sends, or if the staleness guard let a replaced document through.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bid  uuid;
  v_vid  uuid;
  v_vid2 uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_st   text;
  v_row  public.coi_verifications;
begin
  insert into brands (email, company_name, default_coi_url, coi_verification_status)
  values (v_slug || '@invalid.test', 'review probe', 'https://invalid.test/a.pdf', 'pending')
  returning id into v_bid;

  insert into coi_verifications (brand_id, coi_url, status)
  values (v_bid, 'https://invalid.test/a.pdf', 'pending')
  returning id into v_vid;

  -- APPROVE: both rows must move together.
  v_row := review_coi_verification(v_vid, 'approved', 'probe@invalid.test', 'looks fine');
  if v_row.review_decision <> 'approved' or v_row.reviewed_at is null or v_row.reviewed_by is null then
    raise exception 'POST-CONDITION FAILED: approval did not record the decision';
  end if;
  select coi_verification_status into v_st from brands where id = v_bid;
  if v_st <> 'approved' then
    raise exception 'POST-CONDITION FAILED: brand status is % after approval, not approved', v_st;
  end if;

  -- REJECT: the record survives for audit and the brand loses coverage.
  v_row := review_coi_verification(v_vid, 'rejected', 'probe@invalid.test', 'not acceptable');
  select coi_verification_status into v_st from brands where id = v_bid;
  if v_st <> 'rejected' then
    raise exception 'POST-CONDITION FAILED: brand status is % after rejection, not rejected', v_st;
  end if;
  if not exists (select 1 from coi_verifications where id = v_vid) then
    raise exception 'POST-CONDITION FAILED: the rejected record was not retained for audit';
  end if;

  -- INVALID DECISION must be refused.
  begin
    perform review_coi_verification(v_vid, 'maybe', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: an invalid decision was accepted';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on invalid decision (% / %)', sqlstate, sqlerrm;
  end;

  -- STALE REVIEW: the brand replaces its certificate, then the OLD record is approved.
  update brands set default_coi_url = 'https://invalid.test/b.pdf' where id = v_bid;
  insert into coi_verifications (brand_id, coi_url, status)
  values (v_bid, 'https://invalid.test/b.pdf', 'pending')
  returning id into v_vid2;

  begin
    perform review_coi_verification(v_vid, 'approved', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: a STALE record was approved';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on stale review (% / %)', sqlstate, sqlerrm;
  end;

  -- The CURRENT record approves fine.
  v_row := review_coi_verification(v_vid2, 'approved', 'probe@invalid.test', null);
  if v_row.review_decision <> 'approved' then
    raise exception 'POST-CONDITION FAILED: the current record could not be approved';
  end if;

  -- A rejected record can still be REJECTED when stale: only approval is staleness-guarded,
  -- because rejecting a superseded document is always safe.
  v_row := review_coi_verification(v_vid, 'rejected', 'probe@invalid.test', null);
  if v_row.review_decision <> 'rejected' then
    raise exception 'POST-CONDITION FAILED: a stale record could not be rejected';
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'review_coi_verification(): executed post-conditions passed (approve, reject, invalid refused, stale approval refused, stale rejection allowed); probe rolled back';
    else
      raise;
    end if;
end $$;
