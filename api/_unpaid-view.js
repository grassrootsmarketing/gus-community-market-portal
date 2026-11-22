// api/_unpaid-view.js: what a brand is shown about its unpaid reservations (Codex brand-walk order item 3).
//
// One row per booking that is unpaid and still holds a slot ('pending_payment' or 'held'), with the state a person can
// act on and the amounts from the ledger. Pure: the route reads the rows, this decides what they mean.
//
//   state 'awaiting_coi'      held, and the brand's certificate does not cover the demo date yet
//         'awaiting_payment'  payable now: pending_payment, or held with a certificate that now covers the date
//   in_checkout               the booking already belongs to a payment group (a checkout was started). Its group is
//                             immutable, so it is resumed as that exact set; it can never be added to another cart.
//   pay_by                    bookings.unpaid_expires_at (0123): the slot is released at this time
//
// Amounts come from the booking's allocation when one exists (the immutable snapshot the brand will be charged), else
// from the venue's current fee plus the booking fee the store's arrangement implies. A fee of zero is shown as zero;
// no store component is ever invented.
//
// A booking-only member sees the bookings they made themselves, with their amounts (they are the one paying), and
// nothing about anyone else's.

import { coiCovered } from './_coi-coverage.js';

export const PLATFORM_FEE_CENTS = 1000;

export function unpaidView({ bookings, allocations, brand, role, memberId }) {
  const allocByBooking = new Map();
  const groupMembers = new Map();
  for (const a of allocations || []) {
    if (!a || !a.booking_id) continue;
    allocByBooking.set(String(a.booking_id), a);
    const g = String(a.payment_group_id);
    if (!groupMembers.has(g)) groupMembers.set(g, []);
    groupMembers.get(g).push(a);
  }
  const isBooker = role === 'booker';
  const out = [];
  for (const b of bookings || []) {
    if (!b || b.payment_status !== 'unpaid' || !['pending_payment', 'held'].includes(b.status)) continue;
    if (b.fee_waived === true) continue;   // a free booking never enters checkout
    const mine = !!(memberId && b.booked_by_member_id && String(b.booked_by_member_id) === String(memberId));
    if (isBooker && !mine) continue;
    const keepsAll = !!(b.retailers && b.retailers.platform_keeps_all);
    const covered = coiCovered(brand || {}, b.demo_date).covered === true;
    const alloc = allocByBooking.get(String(b.id)) || null;
    let store, fee;
    if (alloc) { fee = Number(alloc.platform_fee_amount) || 0; store = (Number(alloc.customer_amount) || 0) - fee; }
    else { store = Math.round(Number((b.venues && b.venues.demo_fee) || 0) * 100); fee = keepsAll ? 0 : PLATFORM_FEE_CENTS; }
    const members = alloc ? (groupMembers.get(String(alloc.payment_group_id)) || []) : [];
    const state = (b.status === 'held' && !covered) ? 'awaiting_coi' : 'awaiting_payment';
    out.push({
      id: b.id,
      retailer: b.retailers ? { id: b.retailers.id, name: b.retailers.name, slug: b.retailers.slug } : null,
      venue: b.venues ? { id: b.venues.id, name: b.venues.name } : null,
      demo_date: b.demo_date, demo_time: b.demo_time, product: b.product || null,
      state,
      // a held booking without coverage can only be paid where the card hold exists (the pilot arrangement)
      can_pay: state === 'awaiting_payment' || keepsAll,
      pay_by: b.unpaid_expires_at || null,
      store_fee_cents: store, booking_fee_cents: fee, total_cents: store + fee,
      in_checkout: !!alloc,
      group_booking_ids: members.length ? members.map(m => m.booking_id).sort() : [b.id],
      group_total_cents: members.length ? members.reduce((s, m) => s + (Number(m.customer_amount) || 0), 0) : store + fee,
      booked_by_me: mine,
    });
  }
  // soonest deadline first: the one about to be released is the one to act on
  out.sort((x, y) => String(x.pay_by || '9').localeCompare(String(y.pay_by || '9')) || String(x.id).localeCompare(String(y.id)));
  return out;
}
