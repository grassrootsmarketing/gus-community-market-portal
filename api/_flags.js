// api/_flags.js — closed-launch feature gates and kill switches.
//
// Gate 0 rule: the operator probe must report the REAL effective runtime surface. A flag that no
// route consumes is worse than no flag — it manufactures false confidence. So every value returned
// by flagSnapshot() below is either (a) enforced by a named consumer, or (b) explicitly labelled as
// derived/hard-coded state rather than a control.
//
// Codex G0-C3: kill switches now require an EXACT "true". Unset, empty, misspelled or malformed
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
//   connectedCheckout     (no env control — hard_disabled) api/checkout.js + checkout_claim_group()   hard_disabled

// Gate 0 rebuild marker: forces a fresh build so env changes are picked up.
function exactTrue(v) { return String(v ?? '').trim().toLowerCase() === 'true'; }

export const FLAGS = {
  // --- outside the launch envelope: OFF unless exactly "true" ---
  publicRetailerSignup: exactTrue(process.env.PUBLIC_RETAILER_SIGNUP_ENABLED),
  coiAiVerification: exactTrue(process.env.COI_AI_VERIFICATION_ENABLED),
  coiAutoEnforcement: exactTrue(process.env.COI_AUTO_ENFORCEMENT_ENABLED),

  // --- operational kill switches: also require exactly "true" (G0-C3) ---
  checkoutEnabled: exactTrue(process.env.CHECKOUT_ENABLED),
  coiUploadEnabled: exactTrue(process.env.COI_UPLOAD_ENABLED),
  brandInviteEnabled: exactTrue(process.env.BRAND_INVITE_ENABLED),
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
    // enforced controls
    publicRetailerSignup: FLAGS.publicRetailerSignup,
    coiAiVerification: FLAGS.coiAiVerification,
    checkoutEnabled: FLAGS.checkoutEnabled,
    coiUploadEnabled: FLAGS.coiUploadEnabled,
    brandInviteEnabled: FLAGS.brandInviteEnabled,
    // COI automation: both the raw mode and the EFFECTIVE result after the launch gate
    coiAutoEnforcementFlag: FLAGS.coiAutoEnforcement,
    coiEnforcementModeRaw: coiEnforcementMode(),
    coiEnforcementEffective: coiEnforcementEffective(),
    // not env-controlled: connected checkout is rejected in the handler AND in checkout_claim_group
    connectedCheckout: 'hard_disabled',
    max_cart: maxCartSize(),
  };
}
