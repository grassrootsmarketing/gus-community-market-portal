-- 0062_redeem_resolves_brand_members.sql
-- ============================================================================
-- Agency / alternate-email login. When brand login was unified onto brand-signup
-- (redeem_brand_signup), the function resolved a brand ONLY by brands.email. So an
-- invited agency/team member (a brand_members row whose email differs from the
-- brand's primary email) logging in would fall through to the "create" branch and
-- spawn a DUPLICATE brand instead of accessing the brand they were added to.
--
-- Fix: resolve membership FIRST (brand_members.email), then the primary brands.email,
-- then create. Behaviour for the primary/owner email is unchanged. A member/agency
-- login never touches the brand's profile (they are not the owner and enter no data).
--
-- brand_members is unique on (brand_id, lower(email)); an email may belong to more
-- than one brand, so `limit 1` picks one deterministically-newest — multi-brand
-- account switching for agencies is a separate future enhancement.
--
-- Idempotent: CREATE OR REPLACE, same signature (grants preserved; re-stated for clarity).
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

  -- RESOLVE (0062): membership FIRST. An invited agency/team email logs INTO the brand it was added
  -- to (brand_members) rather than spawning a duplicate. Then the primary brands.email; then create.
  select brand_id into v_brand_id
    from brand_members
   where lower(email) = v_email
   order by created_at desc
   limit 1;

  if v_brand_id is not null then
    -- Member/agency login to an existing brand: DO NOT modify the brand's profile.
    v_created := false;
  else
    select id into v_brand_id from brands where lower(email) = v_email limit 1;

    if v_brand_id is null then
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
    else
      -- Owner claim: fill blank profile fields only, never overwrite non-empty values.
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
    end if;
  end if;

  -- Self membership, idempotent. No-op (keeps existing role) for an agency email already a member;
  -- records the owner for a newly-created brand.
  insert into brand_members (brand_id, email, name, role)
  values (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'admin')
  on conflict do nothing;

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
