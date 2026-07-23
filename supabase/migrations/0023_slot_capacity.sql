-- F5-14 / LG-13: enforce venue slot capacity at the DATABASE so two people can't both book
-- (and pay for) the last spot in a full slot. Also rejects bookings with no/invalid venue.
create or replace function enforce_slot_capacity() returns trigger as $$
declare cap int; taken int;
begin
  if new.venue_id is null then raise exception 'booking requires a valid venue'; end if;
  select max_demos_per_slot into cap from venues where id = new.venue_id and retailer_id = new.retailer_id;
  if cap is null then raise exception 'venue does not belong to this retailer'; end if;
  select count(*) into taken from bookings
    where venue_id = new.venue_id and demo_date = new.demo_date and demo_time = new.demo_time
      and coalesce(status,'pending') not in ('cancelled','declined');
  if taken >= cap then
    raise exception 'slot_full: % already booked for % % (cap %)', taken, new.demo_date, new.demo_time, cap using errcode='check_violation';
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_enforce_slot_capacity on bookings;
create trigger trg_enforce_slot_capacity before insert on bookings
  for each row execute function enforce_slot_capacity();
