-- 0089_verification_windows.sql
-- ============================================================================
-- Verification windows for the code-based sign-in flows (Codex S-2, design review 2026-10-03).
--
-- Problem. A brand or retailer who tapped "Resend" and then typed the FIRST code was refused: both redeem paths
-- (redeem_brand_signup for brands, api/_verify.js consumeChallenge for retailers) compared the guess against the
-- NEWEST challenge row only. The per-row `attempts` counter also moved with "newest", so resends changed which
-- counter a guess hit, and consumeChallenge incremented it read-then-write (lost increments under concurrency).
--
-- Model. One state row per (normalized email, purpose): a VERIFICATION WINDOW.
--   * It is the serialization point: issuance and redemption both lock it (SELECT ... FOR UPDATE), so for one
--     address and purpose they run one at a time. Different addresses and purposes never block each other.
--   * It owns the failed-guess budget: p_max_failed wrong guesses (default 6) in the window exhaust it; every code
--     in that window is then unusable. Resends neither reset the count nor move the deadline.
--   * It owns the deadline: 30 minutes from the FIRST issuance. Every code issued in the window expires at that
--     deadline, so a new code never extends an older one. When the deadline passes, or the window was closed by
--     a success, the next issuance starts a new window (window_seq + 1); codes of earlier windows stay dead.
--   * At most p_max_live (5) live codes per window: issuing a sixth retires the oldest in the same transaction,
--     ordered by created_at then id so the choice is deterministic.
--   * Redemption compares the guess against the whole live set of the current window. A match consumes exactly
--     that row, retires its live siblings and closes the window, so a second valid code can no longer be redeemed
--     and concurrent redeems (same or different codes) issue one session at most.
--   * The matched row's payload is what the caller gets. Nothing is looked up by "newest consumed" any more.
--
-- Callers (service role only):
--   verification_issue(...)        api/_verify.js createChallenge, for both purposes
--   redeem_brand_signup(...)       api/brand-signup.js verify: same signature as 0064, now window-based, and the
--                                  blank-only profile fill now includes default_categories from the matched payload
--                                  (own-brand and brand-new paths only; a team member's login never edits the brand)
--   redeem_retailer_signup(...)    api/retailer-signup.js verify: match + provision in ONE transaction, so a
--                                  provisioning failure rolls the consume back and the code stays usable
--   verification_match(...)        internal helper used by the two redeem functions; executable by nobody else
--
-- Challenges created before this migration carry no window and cannot be redeemed; a caller mid-flow at deploy
-- time requests a new code. The legacy `attempts` column is left in place, unused.
--
-- Idempotent. Applied migrations (0022, 0053, 0062, 0064, 0068) are not edited.
-- ============================================================================

begin;

create table if not exists public.verification_windows (
  email          text        not null,
  purpose        text        not null,
  window_seq     bigint      not null default 1,
  started_at     timestamptz not null default now(),
  deadline       timestamptz not null,
  failed_guesses integer     not null default 0,
  exhausted_at   timestamptz,
  closed_at      timestamptz,
  updated_at     timestamptz not null default now(),
  primary key (email, purpose)
);
alter table public.verification_windows enable row level security;
revoke all on table public.verification_windows from public, anon, authenticated;

alter table public.email_verifications add column if not exists window_seq bigint;
alter table public.email_verifications add column if not exists superseded_at timestamptz;
create index if not exists email_verifications_live_window
  on public.email_verifications (lower(email), purpose, window_seq)
  where consumed_at is null and superseded_at is null;

-- ---------------------------------------------------------------------------
-- Issue a code into the current window (or open a new one).
-- ---------------------------------------------------------------------------
create or replace function public.verification_issue(
  p_email          text,
  p_purpose        text,
  p_code_hash      text,
  p_payload        jsonb   default null,
  p_window_minutes integer default 30,
  p_max_live       integer default 5
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_minutes integer := greatest(1, coalesce(p_window_minutes, 30));
  v_w       verification_windows;
  v_id      uuid;
  v_retired integer := 0;
begin
  if v_email = '' or coalesce(p_purpose, '') = '' or coalesce(p_code_hash, '') = '' then
    raise exception 'verification_issue: email, purpose and code hash are required';
  end if;

  -- Create the state row if this is the first code ever for the pair, then take the lock.
  insert into verification_windows (email, purpose, deadline)
  values (v_email, p_purpose, now() + make_interval(mins => v_minutes))
  on conflict (email, purpose) do nothing;

  select * into v_w from verification_windows where email = v_email and purpose = p_purpose for update;

  -- A closed (succeeded) or lapsed window gives way to a new one. Inside a live window nothing resets.
  if v_w.closed_at is not null or v_w.deadline <= now() then
    update verification_windows
       set window_seq = window_seq + 1, started_at = now(), deadline = now() + make_interval(mins => v_minutes),
           failed_guesses = 0, exhausted_at = null, closed_at = null, updated_at = now()
     where email = v_email and purpose = p_purpose
     returning * into v_w;
  end if;

  insert into email_verifications (email, purpose, code_hash, payload, attempts, expires_at, window_seq)
  values (v_email, p_purpose, p_code_hash, p_payload, 0, v_w.deadline, v_w.window_seq)
  returning id into v_id;

  -- Keep at most p_max_live live codes: retire the oldest beyond the cap, deterministically (created_at, id).
  with live as (
    select id, row_number() over (order by created_at desc, id desc) as rn
      from email_verifications
     where lower(email) = v_email and purpose = p_purpose and window_seq = v_w.window_seq
       and consumed_at is null and superseded_at is null and expires_at > now()
  )
  update email_verifications e
     set superseded_at = now()
    from live
   where live.id = e.id and live.rn > greatest(1, coalesce(p_max_live, 5));
  get diagnostics v_retired = row_count;

  update verification_windows set updated_at = now() where email = v_email and purpose = p_purpose;

  return jsonb_build_object(
    'id', v_id, 'window_seq', v_w.window_seq, 'expires_at', v_w.deadline,
    'retired', v_retired, 'exhausted', v_w.exhausted_at is not null
  );
end $$;

-- ---------------------------------------------------------------------------
-- Match a guess against the live set of the current window. Internal: the two redeem functions call it inside
-- their own transaction. Outcomes: ok | no_active_code | expired | already_used | too_many_attempts | invalid.
-- ---------------------------------------------------------------------------
create or replace function public.verification_match(
  p_email      text,
  p_purpose    text,
  p_code_hash  text,
  p_max_failed integer default 6
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_max   integer := greatest(1, coalesce(p_max_failed, 6));
  v_w     verification_windows;
  v_ch    email_verifications;
  v_live  integer;
begin
  if v_email = '' or coalesce(p_purpose, '') = '' or coalesce(p_code_hash, '') = '' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into v_w from verification_windows where email = v_email and purpose = p_purpose for update;
  if not found then
    return jsonb_build_object('outcome', 'no_active_code');
  end if;
  if v_w.closed_at is not null then
    return jsonb_build_object('outcome', 'already_used');
  end if;
  if v_w.deadline <= now() then
    return jsonb_build_object('outcome', 'expired');
  end if;
  if v_w.exhausted_at is not null then
    return jsonb_build_object('outcome', 'too_many_attempts');
  end if;

  select count(*) into v_live
    from email_verifications
   where lower(email) = v_email and purpose = p_purpose and window_seq = v_w.window_seq
     and consumed_at is null and superseded_at is null and expires_at > now();
  if v_live = 0 then
    return jsonb_build_object('outcome', 'no_active_code');
  end if;

  select * into v_ch
    from email_verifications
   where lower(email) = v_email and purpose = p_purpose and window_seq = v_w.window_seq
     and consumed_at is null and superseded_at is null and expires_at > now()
     and code_hash = p_code_hash
   order by created_at desc, id desc
   limit 1;

  if not found then
    -- One shared budget for the window, incremented under the window lock: concurrent wrong guesses queue here.
    update verification_windows
       set failed_guesses = failed_guesses + 1,
           exhausted_at   = case when failed_guesses + 1 >= v_max then now() else exhausted_at end,
           updated_at     = now()
     where email = v_email and purpose = p_purpose
     returning * into v_w;
    return jsonb_build_object(
      'outcome', case when v_w.exhausted_at is not null then 'too_many_attempts' else 'invalid' end,
      'failed_guesses', v_w.failed_guesses
    );
  end if;

  update email_verifications set consumed_at = now() where id = v_ch.id;
  update email_verifications
     set superseded_at = now()
   where lower(email) = v_email and purpose = p_purpose and window_seq = v_w.window_seq
     and consumed_at is null and superseded_at is null and id <> v_ch.id;
  update verification_windows set closed_at = now(), updated_at = now() where email = v_email and purpose = p_purpose;

  return jsonb_build_object('outcome', 'ok', 'challenge_id', v_ch.id, 'payload', coalesce(v_ch.payload, '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Brand: same signature as 0064; matching is now window-based; resolution order and blank-only fill preserved;
-- default_categories from the MATCHED payload joins the blank-only fill on the own-brand and brand-new paths.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_brand_signup(
  p_email         text,
  p_code_hash     text,
  p_session_token text,
  p_session_days  integer default 30,
  p_max_attempts  integer default 6
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := lower(btrim(coalesce(p_email, '')));
  v_m        jsonb;
  v_brand_id uuid;
  v_created  boolean := false;
  v_payload  jsonb;
  v_expires  timestamptz;
begin
  if v_email = '' or coalesce(p_code_hash, '') = '' or coalesce(p_session_token, '') = '' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  v_m := verification_match(v_email, 'brand_signup', p_code_hash, p_max_attempts);
  if v_m->>'outcome' <> 'ok' then
    return v_m - 'failed_guesses';
  end if;
  v_payload := coalesce(v_m->'payload', '{}'::jsonb);

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
      default_categories = case when coalesce(btrim(default_categories),'') = ''
                          then coalesce(nullif(btrim(v_payload->>'default_categories'),''), default_categories)
                          else default_categories end,
      is_verified  = true,
      updated_at   = now()
    where id = v_brand_id;
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
      insert into brands (email, company_name, contact_name, phone, default_categories, is_verified)
      values (
        v_email,
        coalesce(nullif(btrim(v_payload->>'company_name'), ''), v_email),
        nullif(btrim(v_payload->>'contact_name'), ''),
        nullif(btrim(v_payload->>'phone'), ''),
        nullif(btrim(v_payload->>'default_categories'), ''),
        true
      )
      returning id into v_brand_id;
      v_created := true;
      insert into brand_members (brand_id, email, name, role)
      values (v_brand_id, v_email, nullif(btrim(v_payload->>'contact_name'), ''), 'owner')
      on conflict do nothing;
    end if;
    -- else: agency/member login: v_brand_id resolved from membership; the brand is not touched.
  end if;

  v_expires := now() + make_interval(days => greatest(1, coalesce(p_session_days, 30)));
  insert into brand_account_sessions (brand_id, session_token, email, expires_at)
  values (v_brand_id, p_session_token, v_email, v_expires);

  return jsonb_build_object(
    'outcome', 'ok', 'brand_id', v_brand_id, 'expires_at', v_expires, 'created', v_created
  );
end $$;

-- ---------------------------------------------------------------------------
-- Retailer: match + provision in one transaction. Idempotency stays with provision_verified_retailer (0068):
-- an email that already owns a store gets that store back (no session minted here, as before).
-- ---------------------------------------------------------------------------
create or replace function public.redeem_retailer_signup(
  p_email        text,
  p_code_hash    text,
  p_max_attempts integer default 6
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_m       jsonb;
  v_payload jsonb;
  v_ex_id   uuid;
  v_ex_slug text;
  v_prov    record;
begin
  if v_email = '' or coalesce(p_code_hash, '') = '' then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  v_m := verification_match(v_email, 'retailer_signup', p_code_hash, p_max_attempts);
  if v_m->>'outcome' <> 'ok' then
    return v_m - 'failed_guesses';
  end if;
  v_payload := coalesce(v_m->'payload', '{}'::jsonb);

  select r.id, r.slug into v_ex_id, v_ex_slug
    from retailers r where lower(btrim(r.billing_email)) = v_email limit 1;
  if found then
    return jsonb_build_object('outcome', 'ok', 'already', true, 'retailer_id', v_ex_id, 'slug', v_ex_slug, 'payload', v_payload);
  end if;

  select * into v_prov
    from provision_verified_retailer(
      v_email,
      nullif(btrim(v_payload->>'store_name'), ''),
      nullif(btrim(v_payload->>'phone'), ''),
      nullif(btrim(v_payload->>'contact_name'), ''),
      case when coalesce(v_payload->>'store_count', '') ~ '^[0-9]{1,3}$' then (v_payload->>'store_count')::integer else null end
    );
  if v_prov.retailer_id is null then
    raise exception 'redeem_retailer_signup: provisioning returned no store';
  end if;

  return jsonb_build_object(
    'outcome', 'ok', 'already', coalesce(v_prov.already, false), 'retailer_id', v_prov.retailer_id,
    'slug', v_prov.slug, 'session_id', v_prov.session_id, 'payload', v_payload
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges: the service role runs issue and the two redeems; browser roles run nothing; the match helper is
-- reachable only through the redeem functions (security definer, owner-executed).
-- ---------------------------------------------------------------------------
revoke all on function public.verification_issue(text, text, text, jsonb, integer, integer) from public, anon, authenticated;
grant execute on function public.verification_issue(text, text, text, jsonb, integer, integer) to service_role;

revoke all on function public.verification_match(text, text, text, integer) from public, anon, authenticated, service_role;

revoke all on function public.redeem_brand_signup(text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.redeem_brand_signup(text, text, text, integer, integer) to service_role;

revoke all on function public.redeem_retailer_signup(text, text, integer) from public, anon, authenticated;
grant execute on function public.redeem_retailer_signup(text, text, integer) to service_role;

do $$
declare
  f_issue  text := 'public.verification_issue(text, text, text, jsonb, integer, integer)';
  f_match  text := 'public.verification_match(text, text, text, integer)';
  f_brand  text := 'public.redeem_brand_signup(text, text, text, integer, integer)';
  f_retail text := 'public.redeem_retailer_signup(text, text, integer)';
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, f_issue, 'EXECUTE')  then raise exception '0089 postcondition: % can execute verification_issue', r; end if;
    if has_function_privilege(r, f_match, 'EXECUTE')  then raise exception '0089 postcondition: % can execute verification_match', r; end if;
    if has_function_privilege(r, f_brand, 'EXECUTE')  then raise exception '0089 postcondition: % can execute redeem_brand_signup', r; end if;
    if has_function_privilege(r, f_retail, 'EXECUTE') then raise exception '0089 postcondition: % can execute redeem_retailer_signup', r; end if;
    if has_table_privilege(r, 'public.verification_windows', 'SELECT, INSERT, UPDATE, DELETE') then raise exception '0089 postcondition: % has table privileges on verification_windows', r; end if;
  end loop;
  if has_function_privilege('service_role', f_match, 'EXECUTE') then raise exception '0089 postcondition: service_role can execute verification_match directly'; end if;
  if not has_function_privilege('service_role', f_issue, 'EXECUTE')  then raise exception '0089 postcondition: service_role cannot execute verification_issue'; end if;
  if not has_function_privilege('service_role', f_brand, 'EXECUTE')  then raise exception '0089 postcondition: service_role cannot execute redeem_brand_signup'; end if;
  if not has_function_privilege('service_role', f_retail, 'EXECUTE') then raise exception '0089 postcondition: service_role cannot execute redeem_retailer_signup'; end if;
end $$;

commit;
