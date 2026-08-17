-- 0064_redeem_secure_resolve_order.sql
-- ============================================================================
-- SECURITY FIX for 0062. 0062 resolved brand_members BEFORE brands.email so an
-- invited agency email could log into the brand it joined. But team-invite adds a
-- member IMMEDIATELY (no acceptance), so membership-first let an attacker invite a
-- VICTIM'S email to the ATTACKER'S brand and hijack the victim's next login into it
-- (harvesting anything the victim then uploaded — COI, contact info).
--
-- Fix: resolve the email's OWN brand (brands.email) FIRST; only an email with NO own
-- brand falls through to a team membership (the legitimate agency case). The email's
-- own account always wins, so no invite can capture it. Also: a newly-created brand's
-- creator gets role 'owner' (was 'admin'), so team-remove / team-update-role (owner-
-- gated) actually work.
--
-- Idempotent: CREATE OR REPLACE, same signature.
-- ============================================================================

create or replace function public.redeem_brand_signup(
  p_email        text,
  p_code_hash    text,
  p_session_token text,
  p_session_days  integer default 30,
  p_max_attempts  integer default 6
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(btrim(p_email));
  v_ch       email_verifications;
  v_brand_id uuid;
  v_created  boolean := false;
  v_payload  jsonb;
  v_expires  timestamptz;
begin
  if v_email = '' or coalesce(p_code_hash,'') = '' or coalesce(p_session_token,'') = '' then
    return jsonb_build_object('outcome','invalid');
  end if;

  select * into v_ch
  from email_verifications
  where lower(email) = v_email
    and purpose = 'brand_signup'
    and consumed_at is null
  order by created_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('outcome','already_used');
  end if;

  if v_ch.expires_at <= now() then
    return jsonb_build_object('outcome','expired');
  end if;

  if v_ch.attempts >= p_max_attempts then
    return jsonb_build_object('outcome','too_many_attempts');
  end if;

  if v_ch.code_hash <> p_code_hash then
    update email_verifications set attempts = attempts + 1 where id = v_ch.id;
    return jsonb_build_object('outcome','invalid');
  end if;

  update email_verifications set consumed_at = now() where id = v_ch.id;
  v_payload := coalesce(v_ch.payload, '{}'::jsonb);

  -- RESOLVE (0064, SECURE ORDER): the email's OWN brand FIRST. An email can never be captured into
  -- someone else's brand by an invite, because its own account always resolves first.
  select id into v_brand_id from brands where lower(email) = v_email limit 1;

  if v_brand_id is not null then
    -- Owner claim: fill blank profile fields only; never overwrite non-empty values.
    update brands set
      company_name = case when coalesce(btrim(company_name),'') = ''
                          then coalesce(nullif(btrim(v_payload->>'company_name'),''), company_name)
                          else company_name end,
      contact_name = case when coalesce(btrim(contact_name),'') = ''
                          then coalesce(nullif(btrim(v_payload->>'contact_name'),''), contact_name)
                          else contact_name end,
      phone        = case when coalesce(btrim(phone),'') = ''
                          then coalesce(nullif(btrim(v_payload->>'phone'),''), phone)
                          else phone end,
      is_verified  = true,
      updated_at   = now()
    where id = v_brand_id;
    -- ensure the primary-email owner is recorded as 'owner' (upgrade a prior 'admin' row, else add)
    update brand_members set role = 'owner'
      where brand_id = v_brand_id and lower(email) = v_email and role is distinct from 'owner';
    insert into brand_members (brand_id, email, name, role)
    values (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'owner')
    on conflict do nothing;
  else
    -- No own brand: a legitimately-invited team/agency member, or brand new.
    select brand_id into v_brand_id
      from brand_members
     where lower(email) = v_email
     order by created_at desc
     limit 1;

    if v_brand_id is null then
      -- Brand new: create it and record the creator as OWNER.
      insert into brands (email, company_name, contact_name, phone, is_verified)
      values (
        v_email,
        coalesce(nullif(btrim(v_payload->>'company_name'), ''), v_email),
        nullif(btrim(v_payload->>'contact_name'), ''),
        nullif(btrim(v_payload->>'phone'), ''),
        true
      )
      returning id into v_brand_id;
      v_created := true;
      insert into brand_members (brand_id, email, name, role)
      values (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'owner')
      on conflict do nothing;
    end if;
    -- else: agency/member login → v_brand_id resolved from membership; do NOT touch the brand.
  end if;

  v_expires := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  insert into brand_account_sessions (brand_id, session_token, email, expires_at)
  values (v_brand_id, p_session_token, v_email, v_expires);

  return jsonb_build_object(
    'outcome','ok', 'brand_id', v_brand_id, 'expires_at', v_expires, 'created', v_created
  );
end $$;

revoke all on function public.redeem_brand_signup(text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.redeem_brand_signup(text, text, text, integer, integer)
  to service_role;
