// api/_connect-readiness.js, THE readiness policy for a store's Stripe connected account.
//
// One definition, used by every place that decides or records whether a store can be paid through a destination
// charge (Codex connected-checkout release verdict, 2026-11-13, "Connected-account status work order"):
//
//   api/stripe.js                  connect-status, the admin's refresh, applies connectReadiness() to the account it
//                                  retrieves and stores readinessPatch()
//   api/stripe-connect-webhook.js  the connected-account event route applies the same two functions to the account
//                                  it retrieves from Stripe (never to the event payload)
//   api/checkout.js                the checkout gate accepts a store only when storedConnectReady() is true
//
// The policy: a store is ready only when Stripe's CURRENT account object reports charges enabled, payouts enabled
// AND the transfers capability active. Transfers is the capability a destination charge needs to move the store's
// share to the connected account, so charges and payouts alone are not readiness.
//
// The retailers row has no column for the transfers capability, so the three facts are stored as:
//   stripe_charges_enabled, stripe_payouts_enabled   the two booleans, as Stripe reports them
//   stripe_account_status                            'active' only when all three hold; otherwise 'restricted' when
//                                                    Stripe gives a disabled reason, else 'pending'
// storedConnectReady() therefore requires the status to be 'active' as well as both booleans. A row written before
// this policy (booleans on, status something else) reads as not ready until its next refresh, which is the safe side.

export const CONNECT_READY_STATUS = 'active';

// The decision, from a Stripe Account object. Anything that is not exactly true / 'active' counts as not there.
export function connectReadiness(account) {
  const a = account && typeof account === 'object' ? account : {};
  const charges = a.charges_enabled === true;
  const payouts = a.payouts_enabled === true;
  const transfers = !!a.capabilities && typeof a.capabilities === 'object' && a.capabilities.transfers === 'active';
  const ready = charges && payouts && transfers;
  const disabledReason = (a.requirements && a.requirements.disabled_reason) || null;
  const status = ready ? CONNECT_READY_STATUS : (disabledReason ? 'restricted' : 'pending');
  return { charges_enabled: charges, payouts_enabled: payouts, transfers_active: transfers, ready, status };
}

// What a readiness decision writes onto the retailers row. Only these three columns, nothing else.
export function readinessPatch(readiness) {
  return {
    stripe_charges_enabled: readiness.charges_enabled === true,
    stripe_payouts_enabled: readiness.payouts_enabled === true,
    stripe_account_status: readiness.status,
  };
}

// The readiness of a store no longer reachable on Stripe (the account is gone or the platform lost access to it).
export function notReadyReadiness() {
  return { charges_enabled: false, payouts_enabled: false, transfers_active: false, ready: false, status: 'restricted' };
}

// The checkout gate's reading of a stored retailers row (needs stripe_account_id, stripe_charges_enabled,
// stripe_payouts_enabled and stripe_account_status in the select).
export function storedConnectReady(retailer) {
  const r = retailer && typeof retailer === 'object' ? retailer : {};
  const acct = typeof r.stripe_account_id === 'string' ? r.stripe_account_id.trim() : '';
  return !!acct
    && r.stripe_charges_enabled === true
    && r.stripe_payouts_enabled === true
    && r.stripe_account_status === CONNECT_READY_STATUS;
}
