// api/refund-booking.js — RETIRED (410).
//
// Legacy F5-15/18 per-booking "decline refund". Superseded by api/booking-action.js
// (action:'cancel' | 'decline'), which is the SOLE canonical retailer cancellation/refund path:
// it reserves the exact amount against the booking's immutable payment_allocation (refund_reserve_cas)
// and converges through the verified apply_refund_event() RPC, so a single-booking refund never fans
// out across a multi-demo payment.
//
// This route wrote a nonexistent `bookings.amount_refunded` column (via _refund-recovery.js) and
// therefore 500'd on every paid booking. It is retired rather than fixed — a second refund
// architecture that bypasses the allocation ledger is exactly the split path this project is closing.
// Its dead helpers `_refund-recovery.js` and `_refund-ledger.js` are removed with it.
//
// Kept as an explicit 410 (not deleted) so any lingering caller receives "gone", not an ambiguous
// 404, matching the retirement convention used by brand-portal.js / apply-migrations.js.
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';

export default async function handler(req, res) {
  return res.status(410).json({
    error: 'gone',
    message: 'This refund endpoint has been retired. Refunds are issued through the booking cancel/decline action (POST /api/booking-action).',
  });
  /* eslint-disable no-unreachable */
  // Unreachable behind the 410, and kept exactly for that reason (as brand-portal.js does): this is a
  // money-moving route, so if it is ever revived it is revived with the CSRF guard already on it. It
  // deliberately does NOT restore the old per-booking refund logic — a revival must reserve against the
  // allocation ledger the way booking-action.js does, not write bookings columns directly.
  let _b;
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  if (!requireSameOrigin(req, res, _b)) return;
  return res.status(410).json({ error: 'gone' });
  /* eslint-enable no-unreachable */
}
