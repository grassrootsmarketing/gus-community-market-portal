// api/_retailer-live.js — retailer go-live gate (2026-09-30).
//
// A retailer takes bookings only once Demohub has approved it: retailers.verification_status = 'approved'.
// The column comes from 0056 (NOT NULL, DEFAULT 'pending', CHECK pending|approved|rejected|suspended), so a
// self-service sign-up is created 'pending' and stays unbookable until the owner approves it in the owner panel.
//
// Every route that creates a booking or signs a booking agreement selects verification_status and calls
// retailerIsLive() before doing anything else with the retailer (api/book.js, api/booking.js). The public
// booking page learns the same fact from find-retailer's public-data (accepting_bookings) and shows a notice,
// but the server refusal is the control; the page notice is only the explanation.
export const RETAILER_LIVE_STATUS = 'approved';

export function retailerIsLive(retailer) {
  return !!retailer && retailer.verification_status === RETAILER_LIVE_STATUS;
}

export const NOT_LIVE_BODY = Object.freeze({
  error: 'retailer_not_live',
  message: 'This store is not taking demo bookings on Demohub yet.',
});
