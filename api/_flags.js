// api/_flags.js — closed-launch feature gates and kill switches.
//
// Gate 0 of the Final Closure Work Order freezes the launch envelope. Anything outside it must be
// OFF by default and provably off — not merely "we didn't link to it". Every flag here FAILS CLOSED:
// an unset or malformed value yields the safe state, so a missing env var can never widen the
// surface. Enabling something dangerous requires an explicit, exact "true".
//
// Kill switches (§6C) work the same way in reverse: they are ON by default so the product runs, but
// David can set them to "false" to stop the world without a deploy.

function onlyExactTrue(v) { return String(v ?? '').trim().toLowerCase() === 'true'; }
function notExactFalse(v) { return String(v ?? '').trim().toLowerCase() !== 'false'; }

export const FLAGS = {
  // --- must remain DISABLED for the Gus closed launch (default false) ---
  // public self-service retailer signup — the launch is invite-only, single retailer
  publicRetailerSignup: onlyExactTrue(process.env.PUBLIC_RETAILER_SIGNUP_ENABLED),
  // sending COI documents/extracts to an AI provider — requires David's separate written approval
  coiAiVerification: onlyExactTrue(process.env.COI_AI_VERIFICATION_ENABLED),
  // connected/destination-charge checkout (also gated in the handler and the DB claim function)
  connectedCheckout: onlyExactTrue(process.env.CONNECTED_CHECKOUT_ENABLED),
  // automatic cancellation/refund when a COI expires — must not silently move money
  coiAutoEnforcement: onlyExactTrue(process.env.COI_AUTO_ENFORCEMENT_ENABLED),

  // --- kill switches: ON unless explicitly turned off (default true) ---
  checkoutEnabled: notExactFalse(process.env.CHECKOUT_ENABLED),
  coiUploadEnabled: notExactFalse(process.env.COI_UPLOAD_ENABLED),
  brandInviteEnabled: notExactFalse(process.env.BRAND_INVITE_ENABLED),
};

// Server-enforced maximum demos in one combined payment. Defaults to the reviewed value of 25; set
// LAUNCH_MAX_CART lower for the closed launch. Never unbounded, never client-supplied.
export function maxCartSize() {
  const raw = parseInt(process.env.LAUNCH_MAX_CART ?? '', 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 25) return raw;
  return 25;
}

// Non-sensitive snapshot for the operator build probe (no values, no secrets).
export function flagSnapshot() {
  return { ...FLAGS, max_cart: maxCartSize() };
}
