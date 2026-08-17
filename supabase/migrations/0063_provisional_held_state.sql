-- 0063_provisional_held_state.sql
-- Provisional holds / 24h escrow (feature/provisional-holds; gated by PROVISIONAL_HOLDS_ENABLED).
-- Adds the hold-expiry timestamp to bookings. The 'held' and 'expired' statuses are plain text
-- values — bookings.status has NO check constraint (the 0029 CHECKs are on payment_groups /
-- payment_requests), so no enum/constraint change is needed. See docs/provisional-holds.md.
--
-- Do NOT apply to prod until the whole provisional flow + a live smoke pass; the column is inert
-- with the flag off.
alter table public.bookings add column if not exists held_expires_at timestamptz;

-- The 24h-expiry sweep (cron) finds held bookings by this timestamp; partial index keeps it cheap.
create index if not exists idx_bookings_held_expires
  on public.bookings (held_expires_at)
  where held_expires_at is not null;
