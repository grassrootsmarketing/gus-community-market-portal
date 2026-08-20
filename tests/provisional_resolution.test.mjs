// tests/provisional_resolution.test.mjs
//
// P0-1 / P0-2 (Codex 2026-08-20) regression lock. These are OFFLINE source-contract assertions that
// run in `npm test`/CI on every commit. They do not replace the behavioural proof: the eval requires
// the capture-vs-{sweep,decline,bump} interleaves to be proven against real Stripe test-mode
// authorizations before provisional holds (PROVISIONAL_HOLDS_ENABLED) are turned ON. That staging
// harness lives in the release checklist. What this file guarantees is that the specific defects
// found in round 3 cannot silently regress in the source.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const read = (p) => readFileSync(resolve(p), 'utf8');
const slice = (s, from, to, n = 4000) => {
  const i = s.indexOf(from); if (i < 0) return '';
  const j = to ? s.indexOf(to, i) : -1;
  return s.slice(i, j > i ? j + to.length : i + n);
};

const prov = read('api/_provisional.js');
const bact = read('api/booking-action.js');
const hook = read('api/stripe-webhook.js');

console.log('\n— provisional resolution (P0-1 capture/release race, P0-2 capacity-before-capture) —');

// ---- P0-1: releaseHeldBooking must reconcile on the PI's authoritative state ----
{
  const fn = slice(prov, 'export async function releaseHeldBooking', 'export async function captureHeldBooking');
  check('releaseHeldBooking retrieves the PI after the cancel attempt',
    /stripeGetPaymentIntent\(booking\.payment_intent_id\)/.test(fn), 'no PI re-fetch in release path');
  check('releaseHeldBooking converges a SUCCEEDED (captured) PI to paid, not released',
    /fullPi\.status === 'succeeded'/.test(fn) && /applyCapturedPi\(/.test(fn) && /was_captured:\s*true/.test(fn),
    'succeeded branch does not converge to paid');
  check('releaseHeldBooking only releases when the PI is genuinely canceled',
    /fullPi\.status !== 'canceled'/.test(fn), 'missing the canceled-only guard before apply_authorization_canceled');
  // the exact old bug: apply_authorization_canceled called unconditionally right after unexpected_state.
  const cancelIdx = fn.indexOf('stripeCancelPaymentIntent');
  const applyIdx = fn.indexOf('applyAuthorizationCanceled(');
  const getIdx = fn.indexOf('stripeGetPaymentIntent');
  check('the PI re-fetch happens BEFORE apply_authorization_canceled (no unconditional terminalize)',
    cancelIdx > -1 && getIdx > cancelIdx && applyIdx > getIdx, `cancel=${cancelIdx} get=${getIdx} apply=${applyIdx}`);
}

// ---- P0-1: captureHeldBooking branches on the retrieved PI state ----
{
  const fn = slice(prov, 'export async function captureHeldBooking', 'function H(');
  check('captureHeldBooking applies only when the retrieved PI is succeeded',
    /fullPi\.status !== 'succeeded'/.test(fn) && /applyCapturedPi\(/.test(fn), 'capture does not gate on succeeded');
}

// ---- P0-2: capacity is verified BEFORE the Stripe capture ----
{
  const fn = slice(bact, "if (action === 'confirm' && booking.status === 'held')", 'Race check at confirmation', 3000);
  const capIdx = fn.indexOf('slotCapacityStatus');
  const chargeIdx = fn.indexOf('captureHeldBooking(booking)');
  check('the held-confirm path checks slot capacity before capturing',
    capIdx > -1 && chargeIdx > -1 && capIdx < chargeIdx, `capacity=${capIdx} capture=${chargeIdx}`);
  check('a full slot refuses without charging (slot_at_capacity, no capture)',
    /slot_at_capacity/.test(fn), 'missing pre-capture capacity refusal');
}

// ---- P0-1: the decline/cancel caller refuses a hold captured mid-flight (no charged-but-declined) ----
{
  check('booking-action handles a mid-flight capture on decline/cancel (rel.was_captured)',
    /rel\.was_captured/.test(bact) && /hold_captured/.test(bact), 'decline/cancel does not handle was_captured');
}

// ---- P0-1: the succeeded webhook never silently acks a captured PI on a non-settled group ----
{
  const fn = slice(hook, 'async function handlePaymentIntentSucceeded', 'legacy pre-ledger sessions only', 3500);
  check('the succeeded webhook reconciles ANY non-settled group, not just authorized',
    /!alreadySettled/.test(fn) && /partially_refunded/.test(fn), 'still gated on status === authorized only');
  check('a captured PI without a reconciliation case is thrown (never silently dropped)',
    /capture_not_applied_without_case/.test(fn), 'missing the no-case throw guard');
}

console.log(`\nprovisional resolution: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
