-- 0059_coi_stale_review_fix.sql
-- ============================================================================
-- 0058's staleness guard did not work, and the route test caught it:
--
--     FAIL approving a STALE record is refused -> 200 {"ok":true,"decision":"approved"}
--
-- WHY IT FAILED. 0058 refused approval when
--     coi_verifications.coi_url  IS DISTINCT FROM  brands.default_coi_url
-- which assumes a replacement produces a different path. api/brand-account.js writes
--     const path = `brands/${brandId}.${ext}`
-- with upsert=true. The path is DETERMINISTIC per brand and extension, so a replacement
-- overwrites the same object at the same URL. The document changes; the identifier does not.
-- The comparison was therefore always true and the guard never fired in production shape.
--
-- WHY 0058'S POST-CONDITION PASSED ANYWAY. It set up the stale case with two DIFFERENT
-- urls ('a.pdf' then 'b.pdf'), which is a situation the product never produces. The
-- post-condition proved the code did what I wrote; it could not prove I had written the
-- right thing. That distinction is the same one running under-tested guards keeps exposing
-- in this project, and it is why the route test exists.
--
-- THE CORRECT RULE: a verification record is stale when a NEWER un-reviewed record exists
-- for the same brand. That is true regardless of storage paths, filenames, extensions or
-- upsert behaviour, because it is a statement about REVIEW ORDER rather than about bytes.
-- The URL check is kept as an additional condition -- it still catches the case where a
-- replacement DOES land on a different path, e.g. a PDF replaced by a JPG.
--
-- Replaced in a NEW migration rather than by editing 0058, per Codex: an already-applied
-- migration is not amended. Count 59 -> 60; every explicit assertion reads one variable.
-- ============================================================================

begin;

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
  v_row     public.coi_verifications;
  v_brand   public.brands;
  v_newer   int;
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

  if p_decision = 'approved' then
    -- PRIMARY STALENESS TEST: has the brand uploaded something newer that nobody has
    -- reviewed? Approving an older record would grant coverage to a document the reviewer
    -- never opened. This holds even when both records point at the same storage path,
    -- which is the case 0058 missed.
    select count(*) into v_newer
      from coi_verifications c
     where c.brand_id = v_row.brand_id
       and c.review_decision is null
       and (c.created_at > v_row.created_at
            or (c.created_at = v_row.created_at and c.id <> v_row.id));
    if v_newer > 0 then
      raise exception 'stale review: a newer unreviewed certificate exists for this brand'
        using errcode = 'check_violation';
    end if;

    -- SECONDARY: the record must still describe the brand's current certificate. Catches a
    -- replacement that DID change the path -- a PDF replaced by a JPG, say.
    if v_row.coi_url is distinct from v_brand.default_coi_url then
      raise exception 'stale review: this record does not describe the brand''s current certificate'
        using errcode = 'check_violation';
    end if;
  end if;

  update coi_verifications
     set review_decision = p_decision,
         reviewed_at     = now(),
         reviewed_by     = btrim(p_reviewer),
         review_notes    = p_notes,
         status          = case when p_decision = 'approved' then 'approved' else 'rejected' end
   where id = p_verification_id
  returning * into v_row;

  update brands
     set coi_verification_status = case when p_decision = 'approved' then 'approved' else 'rejected' end
   where id = v_row.brand_id;

  return v_row;
end $$;

revoke all on function public.review_coi_verification(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.review_coi_verification(uuid, text, text, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: reproduce the case 0058 got wrong -- SAME storage path, as the product
-- actually behaves -- and prove approval of the older record is now refused.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bid  uuid;
  v_old  uuid;
  v_new  uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_path text := 'brands/postcondition.pdf';
  v_row  public.coi_verifications;
begin
  insert into brands (email, company_name, default_coi_url, coi_verification_status)
  values (v_slug || '@invalid.test', 'stale probe', v_path, 'pending')
  returning id into v_bid;

  -- Two uploads, SAME path. This is what api/brand-account.js produces, and it is the
  -- shape 0058's post-condition failed to reproduce.
  insert into coi_verifications (brand_id, coi_url, status, created_at)
  values (v_bid, v_path, 'pending', now() - interval '1 hour') returning id into v_old;
  insert into coi_verifications (brand_id, coi_url, status, created_at)
  values (v_bid, v_path, 'pending', now()) returning id into v_new;

  begin
    perform review_coi_verification(v_old, 'approved', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: the OLDER record was approved despite a newer unreviewed one';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on stale approval (% / %)', sqlstate, sqlerrm;
  end;

  -- Rejecting the older record stays allowed: refusing a superseded document is always safe.
  v_row := review_coi_verification(v_old, 'rejected', 'probe@invalid.test', null);
  if v_row.review_decision <> 'rejected' then
    raise exception 'POST-CONDITION FAILED: a stale record could not be rejected';
  end if;

  -- With the older record now reviewed, the NEWEST record is no longer shadowed and approves.
  v_row := review_coi_verification(v_new, 'approved', 'probe@invalid.test', null);
  if v_row.review_decision <> 'approved' then
    raise exception 'POST-CONDITION FAILED: the newest record could not be approved';
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'review_coi_verification(): stale-by-recency guard proven with an IDENTICAL storage path; probe rolled back';
    else
      raise;
    end if;
end $$;
