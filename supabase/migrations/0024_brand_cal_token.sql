-- F5-22 / LG-04: a read-only, revocable calendar token, SEPARATE from the account session.
-- The calendar feed authenticates with this token only; it can never act as a login.
alter table brands add column if not exists cal_feed_token text;
create index if not exists brands_cal_feed_token on brands (cal_feed_token);
