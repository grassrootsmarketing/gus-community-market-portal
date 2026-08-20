-- 0067_coi_review_atomic_expiry.sql
-- ============================================================================
-- Codex round 3 (2026-08-20), P0-4: COI approval and the reviewer-confirmed expiry were not atomic.
--
-- THE DEFECT
--   api/admin-auth.js (owner-coi-review) did the review in TWO steps:
--     1. review_coi_verification(...)  -> committed the immutable approval + brand status
--     2. a separate best-effort PATCH  -> brands.default_coi_expires = <reviewer's date>
--   If step 2 failed (network blip, transient 5xx), the API still returned 200 "approved" while the
--   brand kept the EARLIER brand-entered / AI-derived expiry. Coverage (coiCovered) and the
--   post-approval hold-capture sweep then charged (or refused) against a date the owner never
--   confirmed. The reviewer's decision and the date that decision was about could disagree.
--
-- THE FIX
--   Fold the reviewer-confirmed expiry INTO the review RPC so the decision and the date commit in a
--   single transaction, or not at all:
--     * validate the expiry (required + future for approvals) inside the function;
--     * set coi_verifications.policy_expiry on the reviewed record;
--     * set brands.default_coi_expires on the brand (current version only), alongside the status.
--   api/admin-auth.js passes p_expiry and DROPS the best-effort post-approval PATCH (separate commit).
--
--   The 4-arg signature is dropped so no caller can approve without supplying the expiry. Earlier
--   migrations (0058, 0060) define and self-test their own 4-arg version and run BEFORE this file, so
--   the forward-only clean build is unaffected; the only runtime caller is api/admin-auth.js.
-- ============================================================================

begin;

drop function if exists public.review_coi_verification(uuid, text, text, text);

create or replace function public.review_coi_verification(
  p_verification_id uuid,
  p_decision        text,
  p_reviewer        text,
  p_notes           text default null,
  p_expiry          date default null
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

  -- P0-4: the reviewer-confirmed expiry is REQUIRED for an approval and must be in the future.
  -- Without it a brand could be approved-but-never-covered (coiCovered needs a date). The API also
  -- validates, but the RPC is the authority: no approval commits without a usable coverage date.
  if p_decision = 'approved' then
    if p_expiry is null then
      raise exception 'expiry_required: an approval must carry the certificate policy expiry'
        using errcode = 'check_violation';
    end if;
    if p_expiry <= current_date then
      raise exception 'expiry_in_past: the certificate expiry must be in the future'
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_row from coi_verifications where id = p_verification_id for update;
  if not found then
    raise exception 'verification record not found' using errcode = 'no_data_found';
  end if;
  if v_row.brand_id is null then
    raise exception 'verification record has no brand' using errcode = 'check_violation';
  end if;

  -- IMMUTABLE REVIEWS (0060). A decided record is history; a new decision requires a new upload.
  if v_row.review_decision is not null then
    raise exception 'already decided: this record was % and cannot be re-decided', v_row.review_decision
      using errcode = 'check_violation';
  end if;
  if v_row.removed_at is not null then
    raise exception 'removed record cannot be reviewed' using errcode = 'check_violation';
  end if;

  select * into v_brand from brands where id = v_row.brand_id for update;
  if not found then
    raise exception 'brand not found for this verification' using errcode = 'no_data_found';
  end if;

  if p_decision = 'approved' then
    -- STALE IS AN IDENTITY QUESTION (0060): approval is permitted only for the brand's CURRENT version.
    if v_row.superseded_at is not null then
      raise exception 'stale review: this version was superseded by a later upload'
        using errcode = 'check_violation';
    end if;
    if v_brand.current_coi_verification_id is distinct from v_row.id then
      raise exception 'stale review: this record is not the brand''s current certificate'
        using errcode = 'check_violation';
    end if;
    if v_row.storage_path is distinct from v_brand.default_coi_url then
      raise exception 'stale review: this record''s document is not the brand''s current document'
        using errcode = 'check_violation';
    end if;
  end if;

  update coi_verifications
     set review_decision = p_decision,
         reviewed_at     = now(),
         reviewed_by     = btrim(p_reviewer),
         review_notes    = p_notes,
         status          = case when p_decision = 'approved' then 'approved' else 'rejected' end,
         -- P0-4: record the coverage expiry the owner actually confirmed on THIS record. On a
         -- rejection we leave whatever was parsed at upload; it does not gate anything.
         policy_expiry   = case when p_decision = 'approved' then p_expiry else policy_expiry end
   where id = p_verification_id
  returning * into v_row;

  -- Only the current version may move the brand's entitlement. Rejecting a superseded record is
  -- allowed for housekeeping but must not change what the brand is entitled to.
  if v_brand.current_coi_verification_id is not distinct from v_row.id then
    update brands
       set coi_verification_status = case when p_decision = 'approved' then 'approved' else 'rejected' end,
           -- P0-4: the reviewer-confirmed expiry commits in the SAME transaction as the decision.
           -- On approval it overwrites any brand-entered / AI-derived date; on rejection it is
           -- untouched (the brand is not covered anyway).
           default_coi_expires = case when p_decision = 'approved' then p_expiry else default_coi_expires end
     where id = v_row.brand_id;
  end if;

  return v_row;
end $$;

revoke all on function public.review_coi_verification(uuid, text, text, text, date) from public, anon, authenticated;
grant execute on function public.review_coi_verification(uuid, text, text, text, date) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: prove the atomic behaviour, then roll the probe back.
--   1. an approval WITHOUT an expiry is refused (no partial approval can commit);
--   2. an approval WITH an expiry commits decision + brand status + brand expiry + record expiry
--      together;
--   3. after refusal, the brand is untouched (still pending, expiry unset).
-- ---------------------------------------------------------------------------
do $$
declare
  v_bid  uuid;
  v_vid  uuid := gen_random_uuid();
  v_slug text := '__pc0067_' || replace(gen_random_uuid()::text, '-', '');
  v_status text;
  v_bexp date;
  v_pexp date;
  v_exp  date := (current_date + 200);
begin
  insert into brands (email, company_name) values (v_slug || '@invalid.test', 'P0-4 probe')
  returning id into v_bid;

  perform finalize_coi_upload(v_bid, v_vid, 'brands/' || v_bid || '/' || v_vid || '.pdf', 'sha-x', null, 'pending');

  -- 1. approval without an expiry MUST be refused.
  begin
    perform review_coi_verification(v_vid, 'approved', 'probe@invalid.test', null, null);
    raise exception 'POST-CONDITION FAILED: an approval with no expiry was accepted';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on no-expiry approval (% / %)', sqlstate, sqlerrm;
  end;

  -- ...and the refusal left the brand untouched.
  select coi_verification_status, default_coi_expires into v_status, v_bexp from brands where id = v_bid;
  if v_status = 'approved' or v_bexp is not null then
    raise exception 'POST-CONDITION FAILED: a refused approval still moved the brand (status=%, expires=%)', v_status, v_bexp;
  end if;

  -- 2. approval WITH an expiry commits everything atomically.
  perform review_coi_verification(v_vid, 'approved', 'probe@invalid.test', 'ok', v_exp);
  select coi_verification_status, default_coi_expires into v_status, v_bexp from brands where id = v_bid;
  select policy_expiry into v_pexp from coi_verifications where id = v_vid;
  if v_status <> 'approved' then
    raise exception 'POST-CONDITION FAILED: brand not approved after a valid approval (status=%)', v_status;
  end if;
  if v_bexp is distinct from v_exp then
    raise exception 'POST-CONDITION FAILED: brand.default_coi_expires=% did not match reviewer expiry=%', v_bexp, v_exp;
  end if;
  if v_pexp is distinct from v_exp then
    raise exception 'POST-CONDITION FAILED: coi_verifications.policy_expiry=% did not match reviewer expiry=%', v_pexp, v_exp;
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'P0-4: atomic COI review proven (no-expiry approval REFUSED and inert; valid approval commits decision + brand status + brand expiry + record expiry together); probe rolled back';
    else
      raise;
    end if;
end $$;
