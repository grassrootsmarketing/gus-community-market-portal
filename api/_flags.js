// api/_flags.js — closed-launch feature gates and kill switches.
//
// Gate 0 rule: the operator probe must report the REAL effective runtime surface. A flag that no
// route consumes is worse than no flag — it manufactures false confidence. So every value returned
// by flagSnapshot() below is either (a) enforced by a named consumer, or (b) explicitly labelled as
// derived/hard-coded state rather than a control.
//
// Codex G0-C3/G0-v2-3: kill switches require the LITERAL string "true" (case/whitespace variants rejected). Unset, empty, misspelled or malformed
// values DISABLE the operation. This is a deliberate change from availability-first defaults — the
// closed launch prefers a hard stop over an accidentally-open surface, and it makes the packet's
// "malformed configuration cannot widen the surface" statement actually true.
//
// Effective-state map (reported field -> env var -> consuming condition -> safe default):
//   publicRetailerSignup  PUBLIC_RETAILER_SIGNUP_ENABLED  api/retailer-signup.js (403 when false)     false
//   coiAiVerification     COI_AI_VERIFICATION_ENABLED     api/brand-account.js verifyCoiWithClaude()  false
//   checkoutEnabled       CHECKOUT_ENABLED                api/checkout.js (503 when false)            false
//   coiUploadEnabled      COI_UPLOAD_ENABLED              api/brand-account.js action=upload-coi      false
//   brandInviteEnabled    BRAND_INVITE_ENABLED            api/brand-account.js action=team-invite     false
//   coiAutoEnforcement    COI_AUTO_ENFORCEMENT_ENABLED    api/coi-enforcement.js (dual gate w/ mode)  false
//   coiEnforcementEffective  (derived)                    same parser the worker uses                 'off'
//   notificationWorker    NOTIFICATION_WORKER_ENABLED     api/notification-worker.js (200 disabled) +   false
//                                                         api/find-retailer.js (job required only when on)
//   connectedCheckout     (no env control — hard_disabled) api/checkout.js + checkout_claim_group()   hard_disabled

// G0-v2-3: LITERAL comparison. No trimming, no case-folding. "TRUE", " true ", "True" are all
// DISABLED. Normalisation would contradict the stated safety property, so the strict form is the
// design of record for the closed launch.
function exactTrue(v) { return v === 'true'; }

export const FLAGS = {
  // --- outside the launch envelope: OFF unless exactly "true" ---
  publicRetailerSignup: exactTrue(process.env.PUBLIC_RETAILER_SIGNUP_ENABLED),
  coiAiVerification: exactTrue(process.env.COI_AI_VERIFICATION_ENABLED),
  coiAutoEnforcement: exactTrue(process.env.COI_AUTO_ENFORCEMENT_ENABLED),

  // --- operational kill switches: also require exactly "true" (G0-C3) ---
  checkoutEnabled: exactTrue(process.env.CHECKOUT_ENABLED),
  coiUploadEnabled: exactTrue(process.env.COI_UPLOAD_ENABLED),
  // Provisional holds / 24h escrow: book without a verified COI, funds are AUTHORIZED (held, not
  // charged) and captured on confirm/verify within 24h, else the hold is cancelled. See
  // docs/provisional-holds.md. Off = current hard-gate + immediate-charge behavior.
  provisionalHolds: exactTrue(process.env.PROVISIONAL_HOLDS_ENABLED),
  brandInviteEnabled: exactTrue(process.env.BRAND_INVITE_ENABLED),
  // Release A: the store-contact / COI notification outbox worker (api/notification-worker.js).
  // Off = the route answers 200 {disabled:true}, writes no heartbeat, and the status probe does not
  // require the job. Turn on only after 0074 is applied and RESEND_API_KEY is bound.
  notificationWorker: exactTrue(process.env.NOTIFICATION_WORKER_ENABLED),
  // Release B: per-location demo-slot and blackout EDITING (api/admin.js availability actions that
  // carry a slot list, the blackout action, and the admin editors). Off = existing configurations
  // keep being enforced and read, hours/capacity autosave still works, but no new slot/blackout
  // intake — the documented forward-fix/disable path (Codex B-07). Reverting to pre-B code is NOT a
  // compatible rollback once custom slots exist.
  // Read at request time (getter) rather than at module load: the kill switch is still the literal
  // "true" rule, but the consuming routes see the CURRENT value, which also lets the OFF matrix be
  // proven in-process (tests/release_b_corrections.test.mjs R4) without re-importing the module graph.
  get slotEditing() { return exactTrue(process.env.SLOT_EDITING_ENABLED); },
};

// The COI worker's own mode ladder. Parsed here with the SAME rule the worker uses so the probe and
// the worker can never disagree. Unrecognised values collapse to 'off'.
export function coiEnforcementMode() {
  const raw = String(process.env.COI_ENFORCEMENT_MODE || 'off').toLowerCase().trim();
  return ['off', 'dry_run', 'warn_only', 'live'].includes(raw) ? raw : 'off';
}

// EFFECTIVE COI automation state: the Boolean launch flag AND the mode must both permit work.
// If the launch flag is not exactly "true", the answer is 'off' no matter what the mode says —
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
    notificationWorker: FLAGS.notificationWorker,
    // COI automation: both the raw mode and the EFFECTIVE result after the launch gate
    coiAutoEnforcementFlag: FLAGS.coiAutoEnforcement,
    coiEnforcementModeRaw: coiEnforcementMode(),
    coiEnforcementEffective: coiEnforcementEffective(),
    // not env-controlled: connected checkout is rejected in the handler AND in checkout_claim_group
    connectedCheckout: 'hard_disabled',
    max_cart: maxCartSize(),
  };
}
