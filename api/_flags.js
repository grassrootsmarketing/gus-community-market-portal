// api/_flags.js, closed-launch feature gates and kill switches.
//
// Gate 0 rule: the operator probe must report the REAL effective runtime surface. A flag that no
// route consumes is worse than no flag, it manufactures false confidence. So every value returned
// by flagSnapshot() below is either (a) enforced by a named consumer, or (b) explicitly labelled as
// derived/hard-coded state rather than a control.
//
// Codex G0-C3/G0-v2-3: kill switches require the LITERAL string "true" (case/whitespace variants rejected). Unset, empty, misspelled or malformed
// values DISABLE the operation. This is a deliberate change from availability-first defaults, the
// closed launch prefers a hard stop over an accidentally-open surface, and it makes the packet's
// "malformed configuration cannot widen the surface" statement actually true.
//
// Effective-state map (reported field -> env var -> consuming condition -> safe default):
//   publicRetailerSignup  PUBLIC_RETAILER_SIGNUP_ENABLED  api/retailer-signup.js (403 when false)     false
//   coiAiVerification     COI_AI_VERIFICATION_ENABLED     api/brand-account.js verifyCoiWithClaude()  false
//   checkoutEnabled       CHECKOUT_ENABLED                api/checkout.js (503 when false)            false
//   coiUploadEnabled      COI_UPLOAD_ENABLED              api/brand-account.js action=upload-coi      false
//   brandInviteEnabled    BRAND_INVITE_ENABLED            RETIRED 2026-10-17 (brand teams removed; the env var is ignored)  false
//   coiAutoEnforcement    COI_AUTO_ENFORCEMENT_ENABLED    api/coi-enforcement.js (dual gate w/ mode)  false
//   coiEnforcementEffective  (derived)                    same parser the worker uses                 'off'
//   signinMaintenance     SIGNIN_MAINTENANCE_ENABLED      api/_signin-config.js (503 on brand-signup +  false
//                                                         retailer-signup request AND verify, before quotas)
//   notificationWorker    NOTIFICATION_WORKER_ENABLED     api/notification-worker.js (200 disabled) +   false
//                                                         api/find-retailer.js (job required only when on)
//   connectedCheckout     CONNECTED_CHECKOUT_ENABLED      api/checkout.js (409 for a non-keeps-all store  false
//                                                         when off; on = the store must be payout-ready)

// G0-v2-3: LITERAL comparison. No trimming, no case-folding. "TRUE", " true ", "True" are all
// DISABLED. Normalisation would contradict the stated safety property, so the strict form is the
// design of record for the closed launch.
function exactTrue(v) { return v === 'true'; }

export const FLAGS = {
  // --- outside the launch envelope: OFF unless exactly "true" ---
  get publicRetailerSignup() { return exactTrue(process.env.PUBLIC_RETAILER_SIGNUP_ENABLED); },
  get coiAiVerification() { return exactTrue(process.env.COI_AI_VERIFICATION_ENABLED); },
  get coiAutoEnforcement() { return exactTrue(process.env.COI_AUTO_ENFORCEMENT_ENABLED); },

  // --- operational kill switches: also require exactly "true" (G0-C3) ---
  get checkoutEnabled() { return exactTrue(process.env.CHECKOUT_ENABLED); },
  get coiUploadEnabled() { return exactTrue(process.env.COI_UPLOAD_ENABLED); },
  // Provisional holds / 24h escrow: book without a verified COI, funds are AUTHORIZED (held, not
  // charged) and captured on confirm/verify within 24h, else the hold is cancelled. See
  // docs/provisional-holds.md. Off = current hard-gate + immediate-charge behavior.
  get provisionalHolds() { return exactTrue(process.env.PROVISIONAL_HOLDS_ENABLED); },
  get brandInviteEnabled() { return exactTrue(process.env.BRAND_INVITE_ENABLED); },
  // Release A: the store-contact / COI notification outbox worker (api/notification-worker.js).
  // Off = the route answers 200 {disabled:true}, writes no heartbeat, and the status probe does not
  // require the job. Turn on only after 0074 is applied and RESEND_API_KEY is bound.
  get notificationWorker() { return exactTrue(process.env.NOTIFICATION_WORKER_ENABLED); },
  // Release B: per-location demo-slot and blackout EDITING (api/admin.js availability actions that
  // carry a slot list, the blackout action, and the admin editors). Off = existing configurations
  // keep being enforced and read, hours/capacity autosave still works, but no new slot/blackout
  // intake, the documented forward-fix/disable path (Codex B-07). Reverting to pre-B code is NOT a
  // compatible rollback once custom slots exist.
  // Read at request time (getter) rather than at module load (every flag, since 2026-10-21: a module that imports this
  // file before the environment is complete, as the test harness does when a suite imports the outbox directly, must
  // still see the live value; in Vercel the environment is fixed for the life of the process, so this changes nothing there): the kill switch is still the literal
  // "true" rule, but the consuming routes see the CURRENT value, which also lets the OFF matrix be
  // proven in-process (tests/release_b_corrections.test.mjs R4) without re-importing the module graph.
  get slotEditing() { return exactTrue(process.env.SLOT_EDITING_ENABLED); },
  // Booking codes (0085, Codex BC R1 2026-10-13): ISSUANCE and REDEMPTION of codes. Exactly "true" = on. Anything
  // else = the "compatible disabled build": no code can be generated (retailer or owner), previewed or applied to a
  // booking, while everything that already exists keeps working: codes are listed and can be turned off, waived
  // bookings display, fulfil, confirm, cancel, are refused by checkout, and recover by operation key. Read at request
  // time so flipping the Vercel variable + redeploy is the whole switch.
  get bookingCodes() { return exactTrue(process.env.BOOKING_CODES_ENABLED); },
  // Codex C-1 (2026-10-03): maintenance gate for the CODE-BASED sign-in flows only (brand sign-in/sign-up,
  // retailer sign-up: request and verify). On = those routes answer 503 before any quota is spent, so a schema
  // switch (migration 0089) can happen with no half-working issuance. Payments, existing sessions, the
  // notification worker, magic-link retailer login and every other route are untouched. Set in Vercel
  // Production and redeploy to close; unset and redeploy to reopen. Read at request time.
  get signinMaintenance() { return exactTrue(process.env.SIGNIN_MAINTENANCE_ENABLED); },
  // Retailer-initiated demo moves (0094/0095, Codex RM-7 2026-10-16): CREATION of a move only. Exactly "true" = the
  // retailer admin offers "Move demo" and api/booking-action action 'move' accepts. Anything else = the compatible
  // disabled build: new moves are refused (503 retailer_moves_disabled) and the dialog offers only the ask-first
  // proposal, while every move that already exists keeps working: brand confirm/decline, the deadline lapse, the
  // cancellation + refund settlement, reminders and notices. Read at request time.
  get retailerMoves() { return exactTrue(process.env.RETAILER_MOVES_ENABLED); },
  // Owner COI expiry pings (0093, Codex C2 2026-10-21): the whole feature. Exactly "true" = the notification worker
  // schedules the 30 / 14 / 3 day owner reminders AND dispatches the ones that are due. Anything else = off: no new
  // rows, and rows already queued (pending, failed, unknown, frozen retries) are NEITHER claimed NOR sent; they wait
  // untouched, so re-enabling resumes them under the normal catch-up window (a row whose window passed meanwhile is
  // recorded skipped 'expired', never sent late). Every other notification kind is unaffected. Read at request time:
  // set in Vercel (Production; Preview only for a deliberate contained test) and redeploy; a send already handed to
  // the provider cannot be recalled.
  get coiExpiryPings() { return exactTrue(process.env.COI_EXPIRY_PINGS_ENABLED); },
  // Connected checkout (0116, revenue split rehearsal 2026-10-30): destination charges for a store that is NOT
  // platform_keeps_all (the brand pays the store's demo fee plus the $10 platform fee; Stripe routes the demo fee
  // to the store's connected account and keeps the platform fee on Demohub). Exactly "true" = api/checkout.js
  // accepts a non-keeps-all store that is payout-ready (stripe_account_id present and stripe_charges_enabled).
  // Anything else = today's pilot behaviour: every non-keeps-all checkout is refused 409
  // connected_checkout_unavailable_pilot before any claim, so no connected payment group can be created. A group
  // that already exists keeps working through every later path (webhook apply, refunds, workers), which never
  // consult this flag. Read at request time: set in Vercel (Production and Preview separately) and redeploy.
  get connectedCheckout() { return exactTrue(process.env.CONNECTED_CHECKOUT_ENABLED); },
};

// The COI worker's own mode ladder. Parsed here with the SAME rule the worker uses so the probe and
// the worker can never disagree. Unrecognised values collapse to 'off'.
export function coiEnforcementMode() {
  const raw = String(process.env.COI_ENFORCEMENT_MODE || 'off').toLowerCase().trim();
  return ['off', 'dry_run', 'warn_only', 'live'].includes(raw) ? raw : 'off';
}

// EFFECTIVE COI automation state: the Boolean launch flag AND the mode must both permit work.
// If the launch flag is not exactly "true", the answer is 'off' no matter what the mode says,
// so a stray COI_ENFORCEMENT_MODE=live cannot cancel or refund anything.
export function coiEnforcementEffective() {
  if (!FLAGS.coiAutoEnforcement) return 'off';
  return coiEnforcementMode();
}

// Server-enforced maximum demos in one combined payment. Never client-supplied.
export function maxCartSize() {
  const raw = parseInt(process.env.LAUNCH_MAX_CART ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 25) return raw;
  return 25;
}

// Non-sensitive effective-surface snapshot for the operator probe (no values, no secrets).
export function flagSnapshot() {
  return {
    // CL-02 (Codex final work order): the closed-launch envelope's single most important condition is
    // that provisional holds are OFF. Report the EFFECTIVE value so the operator /api/version probe
    // proves it in fact instead of trusting a document. exactTrue() means only the literal "true" is
    // true; unset/empty/malformed/uppercase/padded/"false" all report false.
    provisionalHolds: FLAGS.provisionalHolds,
    // enforced controls
    publicRetailerSignup: FLAGS.publicRetailerSignup,
    coiAiVerification: FLAGS.coiAiVerification,
    checkoutEnabled: FLAGS.checkoutEnabled,
    coiUploadEnabled: FLAGS.coiUploadEnabled,
    brandInviteEnabled: FLAGS.brandInviteEnabled,
    slotEditing: FLAGS.slotEditing,
    signinMaintenance: FLAGS.signinMaintenance,
    retailerMoves: FLAGS.retailerMoves,
    coiExpiryPings: FLAGS.coiExpiryPings,
    notificationWorker: FLAGS.notificationWorker,
    // COI automation: both the raw mode and the EFFECTIVE result after the launch gate
    coiAutoEnforcementFlag: FLAGS.coiAutoEnforcement,
    coiEnforcementModeRaw: coiEnforcementMode(),
    coiEnforcementEffective: coiEnforcementEffective(),
    // 0116: an enforced control (api/checkout.js). Before 0116 this field was the literal 'hard_disabled'.
    connectedCheckout: FLAGS.connectedCheckout,
    max_cart: maxCartSize(),
  };
}
