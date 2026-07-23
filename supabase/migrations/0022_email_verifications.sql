-- F5-02: single-use, race-safe email-ownership verification challenges.
-- Used by retailer signup, brand signup, and login "prove you own this email" flows.
-- Nobody gets a password/session/account until they redeem the emailed code for the
-- matching (email, purpose). Additive + idempotent.

create table if not exists email_verifications (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  purpose     text not null,            -- 'retailer_signup' | 'brand_signup' | 'login'
  code_hash   text not null,            -- hash of the 6-digit code (never store the code raw)
  payload     jsonb,                    -- pending non-secret signup data (store name, etc.)
  attempts    int not null default 0,
  consumed_at timestamptz,              -- set once, atomically, on successful redeem
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists email_verifications_lookup
  on email_verifications (lower(email), purpose, consumed_at);
