-- 0053_brand_signup_atomic.sql
-- ============================================================================
-- Codex finding A: brand signup wrote before the caller proved they owned the email.
--
-- `api/brand-account.js?action=signup` — the handler the UI actually calls — did all of
-- this BEFORE any verification:
--   * PATCHed an existing passwordless brand's profile (so anyone could overwrite the
--     company name, phone and contact of a brand they do not own, by "signing up" as it)
--   * INSERTed a new brands row
--   * INSERTed a brand_members owner row
--   * created a brand_account_sessions session and returned it
--
-- A second implementation existed in api/brand-signup.js, unused by the UI and itself
-- incomplete. Two code paths for one security-critical flow means the reviewed one and
-- the reachable one can differ — and here they did.
--
-- THIS MIGRATION provides the atomic half. Codex requires verification, provisioning,
-- membership, session creation and challenge consumption to be one unit: no partially
-- provisioned brand, and no possibility of the challenge being consumed while
-- provisioning fails (or worse, the reverse).
--
-- CONCURRENCY: the challenge row is claimed with FOR UPDATE and its consumed_at is set
-- inside the same transaction, so parallel redeem attempts serialize and exactly one
-- wins. That is what stops the "fire N requests at once to beat the attempt counter"
-- bypass — the counter is incremented under the same lock.
--
-- Idempotent.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Durable, per-identity attempt accounting for verification challenges.
-- ---------------------------------------------------------------------------
-- The existing `attempts` column on email_verifications counts guesses against ONE
-- challenge row. An attacker who requests a fresh challenge each time resets it. This
-- table survives challenge churn, and is keyed on the exact normalized email and on the
-- client IP independently, so neither axis alone can be used to exhaust the other.
create table if not exists public.verification_throttle (
  id           bigserial primary key,
  scope        text not null check (scope in ('email', 'ip')),
  key          text not null,
  purpose      text not null,
  window_start timestamptz not null default now(),
  attempts     integer not null default 0,
  blocked_until timestamptz
);

create unique index if not exists verification_throttle_unique
  on public.verification_throttle (scope, key, purpose, window_start);
create index if not exists verification_throttle_lookup
  on public.verification_throttle (scope, key, purpose, blocked_until);

alter table public.verification_throttle enable row level security;
revoke all on public.verification_throttle from anon, authenticated;
revoke all on sequence public.verification_throttle_id_seq from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Atomic redeem + provision.
-- ---------------------------------------------------------------------------
-- Returns jsonb:
--   {outcome:'ok', brand_id, session_token, expires_at, created:boolean}
--   {outcome:'invalid'}            code did not match (attempts incremented)
--   {outcome:'expired'}
--   {outcome:'already_used'}
--   {outcome:'too_many_attempts'}
-- The caller must map these to responses that do NOT distinguish "wrong code" from
-- "no such challenge" to an unauthenticated client.
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

  -- Claim the newest unconsumed challenge for this exact normalized email. FOR UPDATE
  -- serializes concurrent redeem attempts on the same identity.
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

  -- Wrong code: count the attempt under the same lock and stop. Because the increment
  -- happens inside this transaction, N parallel guesses cannot all read the same
  -- pre-increment value.
  if v_ch.code_hash <> p_code_hash then
    update email_verifications set attempts = attempts + 1 where id = v_ch.id;
    return jsonb_build_object('outcome','invalid');
  end if;

  -- Correct code. Consume the challenge FIRST so a replay in a parallel transaction
  -- finds it already consumed.
  update email_verifications set consumed_at = now() where id = v_ch.id;
  v_payload := coalesce(v_ch.payload, '{}'::jsonb);

  -- Provision. Only NOW may anything be written to brands.
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
    -- Existing brand: the caller has now PROVEN they control this address, so filling in
    -- blank profile fields is legitimate. Never overwrite a non-empty value — that was
    -- the takeover primitive in the old handler.
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

  -- Owner membership, idempotent against the existing unique index.
  insert into brand_members (brand_id, email, name, role)
  values (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'admin')
  on conflict do nothing;

  -- Session, in the same transaction.
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

-- ---------------------------------------------------------------------------
-- Durable throttle check + increment, atomic.
-- ---------------------------------------------------------------------------
create or replace function public.verification_throttle_hit(
  p_scope   text,
  p_key     text,
  p_purpose text,
  p_limit   integer,
  p_window_minutes integer default 60,
  p_block_minutes  integer default 60
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key    text := lower(btrim(p_key));
  v_window timestamptz := date_trunc('hour', now())
                          + (floor(extract(minute from now()) / greatest(1, p_window_minutes))
                             * make_interval(mins => greatest(1, p_window_minutes)));
  v_row    public.verification_throttle;
begin
  if v_key = '' then return jsonb_build_object('allowed', false, 'reason', 'no_key'); end if;

  insert into public.verification_throttle (scope, key, purpose, window_start, attempts)
  values (p_scope, v_key, p_purpose, v_window, 0)
  on conflict (scope, key, purpose, window_start) do nothing;

  select * into v_row from public.verification_throttle
  where scope = p_scope and key = v_key and purpose = p_purpose and window_start = v_window
  for update;

  if v_row.blocked_until is not null and v_row.blocked_until > now() then
    return jsonb_build_object('allowed', false, 'reason', 'blocked', 'until', v_row.blocked_until);
  end if;

  if v_row.attempts + 1 > p_limit then
    update public.verification_throttle
      set attempts = attempts + 1,
          blocked_until = now() + make_interval(mins => greatest(1, p_block_minutes))
      where id = v_row.id;
    return jsonb_build_object('allowed', false, 'reason', 'limit_exceeded');
  end if;

  update public.verification_throttle set attempts = attempts + 1 where id = v_row.id;
  return jsonb_build_object('allowed', true, 'attempts', v_row.attempts + 1, 'limit', p_limit);
end $$;

revoke all on function public.verification_throttle_hit(text, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.verification_throttle_hit(text, text, text, integer, integer, integer)
  to service_role;

commit;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='redeem_brand_signup') then
    raise exception 'POST-CONDITION FAILED: redeem_brand_signup() missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='public' and p.proname='verification_throttle_hit') then
    raise exception 'POST-CONDITION FAILED: verification_throttle_hit() missing';
  end if;
  if has_function_privilege('anon', 'public.redeem_brand_signup(text,text,text,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.redeem_brand_signup(text,text,text,integer,integer)', 'EXECUTE') then
    raise exception 'POST-CONDITION FAILED: redeem_brand_signup is reachable by a browser role';
  end if;
  if (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='verification_throttle') is distinct from true then
    raise exception 'POST-CONDITION FAILED: RLS not enabled on verification_throttle';
  end if;
end $$;
