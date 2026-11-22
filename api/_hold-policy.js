// api/_hold-policy.js: the one rule for whether a brand without an approved certificate may book.
//
// A provisional hold (book now, card authorized, 24h to get the certificate approved) is only supported where
// Demohub collects the payment (retailers.platform_keeps_all = true, the pilot arrangement). At a store on the
// split, checkout refuses a held cart (store_requires_insurance_on_file), so a held booking there would reserve
// capacity that can never be paid. It is refused here, before anything is written.
//
// Inputs are server-read values only: the launch flag, the retailer row and coiCovered() for the demo date.
// An uploaded certificate that is pending, rejected or expired for the date is "not covered"; uploading is not approval.

export const STORE_REQUIRES_INSURANCE = {
  error: 'store_requires_insurance_on_file',
  message: 'This store can only take bookings from brands with insurance on file. Upload your certificate of insurance, or contact the store.',
};

// -> 'book'          covered: an ordinary booking that goes to checkout
//    'hold'          not covered, holds on, keeps-all store: a provisional held booking
//    'refuse_store'  not covered, holds on, store on the split: refused, nothing written
//    'refuse_coi'    not covered, holds off: the plain certificate gate
export function holdDecision({ holdsEnabled, keepsAll, covered }) {
  if (covered === true) return 'book';
  if (holdsEnabled !== true) return 'refuse_coi';
  return keepsAll === true ? 'hold' : 'refuse_store';
}
