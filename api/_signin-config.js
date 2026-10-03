// api/_signin-config.js — sign-in configuration readiness (Codex S-1, 2026-10-03).
//
// The code-based sign-in flows (brand sign-in/sign-up via api/brand-signup.js, retailer sign-up via
// api/retailer-signup.js) answer every request with the same generic reply so an attacker cannot learn whether an
// address exists. That same reply used to hide our OWN misconfiguration: without the hashing secret the challenge
// could not be created, the error was swallowed, the page showed "a code is on its way" and nothing was sent
// (observed on the Preview, 2026-10-02). This module is the ONE validator those routes and the health check share.
//
// Rules:
//   * It checks configuration only: the hashing secret is present and at least MIN_PEPPER_LEN characters after
//     trimming (the compatibility floor api/_verify.js has always enforced), and the binding carries a mail provider key.
//     It never returns a secret value.
//   * Routes call it at their boundary, BEFORE spending address or network request quotas and before any
//     account-specific lookup, and answer SIGNIN_UNAVAILABLE (503), identical for every address. A global outage is
//     not an account-existence signal. Address-specific throttles and account outcomes keep their generic replies.
//   * Unrelated routes are unaffected: this is not part of getBinding(), so payments, bookings and the notification
//     worker keep running on an otherwise valid binding.
//   * Readiness is not proof of delivery: a provider can still refuse a message; routes log that separately
//     (logSigninMailFailure) with a reason code only, never the address, code, hash or provider body.
export const MIN_PEPPER_LEN = 32;

export function signinConfigStatus(binding) {
  const reasons = [];
  const p = process.env.VERIFY_PEPPER;
  if (!p || String(p).trim().length < MIN_PEPPER_LEN) reasons.push('verify_pepper');
  if (!binding || !binding.resendApiKey) reasons.push('mail_provider');
  return { ok: reasons.length === 0, reasons };
}

export const SIGNIN_UNAVAILABLE = Object.freeze({
  error: 'signin_unavailable',
  message: 'Sign-in is temporarily unavailable. Please try again shortly.',
});

export function logSigninConfigFailure(route, status) {
  console.error(JSON.stringify({ event: 'signin_config_invalid', route, reasons: (status && status.reasons) || [] }));
}

// `sent` is the sendMailQuietly result: { ok: false, code } on a refusal, otherwise the provider result.
export function logSigninMailFailure(route, sent) {
  if (!sent || sent.ok === false) console.error(JSON.stringify({ event: 'signin_mail_failed', route, code: (sent && sent.code) || 'unknown' }));
}
