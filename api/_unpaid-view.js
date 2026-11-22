// api/_unpaid-view.js: what a brand is shown about its unpaid reservations (Codex brand-walk order item 3; states per
// the return review of 9891aba, R4).
//
// One row per booking that is unpaid and holds a slot ('pending_payment' or 'held'), or that lost its slot for not being
// paid in time ('expired', recent). Pure: the route reads the rows, this decides what they mean. Every state is decided
// from server-read rows; nothing here trusts the browser.
//
//   state 'awaiting_coi'        held, and the brand's certificate does not cover the demo date yet
//         'awaiting_payment'    payable now: pending_payment, or held with a certificate that now covers the date
//         'payment_processing'  the provider reports the group's session as paid or complete and the ledger has not applied
//                               it yet (the route asks the provider; see processingGroups). Nothing to do but wait.
//         'window_ended'        the pay-by time has passed, or expiry has begun for the group, and the slot has NOT been
//                               released yet (the worker settles any attempt with the provider first). Not payable.
//         'expired'             the booking was released for not being paid in time. Not payable; book again.
//   can_pay                     true only for 'awaiting_payment', and for 'awaiting_coi' where the card hold exists
//   in_checkout                 the booking already belongs to a payment group (a checkout was started). Its group is
//                               immutable, so it is resumed as that exact set; it can never be added to another cart.
//   pay_by                      when the slot is released: the booking's own deadline (0123), or for a booking in a group
//                               the EARLIEST deadline of that group, because a group ends as one.
//
// Amounts come from the booking's allocation when one exists (the immutable snapshot the brand will be charged), else
// from the venue's current fee plus the booking fee the store's arrangement implies. A fee of zero is shown as zero;
// no store component is ever invented.
//
// A booking-only member sees the bookings they made themselves, with their amounts (they are the one paying), and
// nothing about anyone else's.

import { coiCovered } from './_coi-coverage.js';

export const PLATFORM_FEE_CENTS = 1000;

export function unpaidView({ bookings, allocations, groups, processingGroups, brand, role, memberId, now }) {
  const t = now ? new Date(now).getTime() : Date.now();
  const allocByBooking = new Map();
  const groupMembers = new Map();
  for (const a of allocations || []) {
    if (!a || !a.booking_id) continue;
    allocByBooking.set(String(a.booking_id), a);
    const g = String(a.payment_group_id);
    if (!groupMembers.has(g)) groupMembers.set(g, []);
    groupMembers.get(g).push(a);
  }
  const groupById = new Map((groups || []).filter(Boolean).map(g => [String(g.id), g]));
  const processing = new Set([...(processingGroups || [])].map(String));
  const deadlineOf = new Map((bookings || []).filter(Boolean).map(b => [String(b.id), b.unpaid_expires_at || null]));
  const isBooker = role === 'booker';
  const out = [];
  for (const b of bookings || []) {
    if (!b || b.payment_status !== 'unpaid' || !['pending_payment', 'held', 'expired'].includes(b.status)) continue;
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
    const grp = alloc ? (groupById.get(String(alloc.payment_group_id)) || null) : null;
    // a group ends as one, at the earliest deadline among its bookings
    const groupDeadlines = members.map(m => deadlineOf.get(String(m.booking_id))).filter(Boolean).sort();
    const payBy = groupDeadlines.length ? groupDeadlines[0] : (b.unpaid_expires_at || null);
    const ended = (!!payBy && new Date(payBy).getTime() <= t) || !!(grp && grp.unpaid_expiry_started_at);
    let state;
    if (b.status === 'expired') state = 'expired';
    else if (alloc && processing.has(String(alloc.payment_group_id))) state = 'payment_processing';
    else if (ended) state = 'window_ended';
    else if (b.status === 'held' && !covered) state = 'awaiting_coi';
    else state = 'awaiting_payment';
    out.push({
      id: b.id,
      retailer: b.retailers ? { id: b.retailers.id, name: b.retailers.name, slug: b.retailers.slug } : null,
      venue: b.venues ? { id: b.venues.id, name: b.venues.name } : null,
      demo_date: b.demo_date, demo_time: b.demo_time, product: b.product || null,
      state,
      // a held booking without coverage can only be paid where the card hold exists (the pilot arrangement)
      can_pay: state === 'awaiting_payment' || (state === 'awaiting_coi' && keepsAll),
      pay_by: payBy,
      store_fee_cents: store, booking_fee_cents: fee, total_cents: store + fee,
      in_checkout: !!alloc,
      group_booking_ids: members.length ? members.map(m => m.booking_id).sort() : [b.id],
      group_total_cents: members.length ? members.reduce((s, m) => s + (Number(m.customer_amount) || 0), 0) : store + fee,
      booked_by_me: mine,
    });
  }
  // what still needs the brand first, soonest deadline first; what is over last
  const rank = (x) => (x.state === 'expired' ? 2 : x.state === 'window_ended' ? 1 : 0);
  out.sort((x, y) => rank(x) - rank(y) || String(x.pay_by || '9').localeCompare(String(y.pay_by || '9')) || String(x.id).localeCompare(String(y.id)));
  return out;
}
