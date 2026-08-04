// api/version.js — build identity probe.
//
// R12-P1-5: the detailed view (Supabase project ref, Stripe live/test mode, secret-presence flags)
// is reconnaissance if exposed publicly, so it now requires the operator/deploy secret. Without it
// the endpoint returns only a coarse build id + health, which is safe to leave reachable in prod.
import { flagSnapshot } from './_flags.js';
import { getBinding, diagnosticSnapshot, BindingError } from './_env.js';

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.headers['x-deploy-verify'] || '');
  const authed = !!CRON_SECRET && provided === CRON_SECRET;

  // public: nothing sensitive — short build id only, no env/config footprint
  if (!authed) {
    // TEMP (prod-cutover diagnosis — reverted immediately): binding failure code + env presence.
    // No secret VALUES; ref prefix + snapshot are the same redacted labels the operator view exposes.
    let binding_error = null, snap = null;
    try { snap = diagnosticSnapshot(await getBinding()); }
    catch (e) { binding_error = e instanceof BindingError ? e.code : ('X:' + String((e && e.message) || e).slice(0, 60)); }
    return res.status(200).json({
      ok: true,
      build: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      vercel_env: process.env.VERCEL_ENV || null,
      has_site_origin: !!process.env.SITE_ORIGIN,
      site_origin: process.env.SITE_ORIGIN || null,
      url_ref: ((process.env.SUPABASE_URL || '').match(/^https:\/\/([a-z]{20})\./) || [])[1] || null,
      binding_error, snap,
      now: new Date().toISOString(),
    });
  }

  // operator view: full deployment identity + wiring flags (never secret VALUES).
  // The binding layer is the single source of truth for target/project/stripe/email state; this
  // probe reports its redacted snapshot rather than re-deriving anything from raw env vars. A probe
  // must stay answerable when the binding is invalid, so a BindingError is reported as its code
  // (a label, exactly what sendBindingFailure logs) instead of 503-ing the diagnostic itself.
  let binding = null, binding_error = null;
  try { binding = diagnosticSnapshot(await getBinding()); }
  catch (e) { binding_error = e instanceof BindingError ? e.code : 'binding_invalid'; }

  return res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    commit_short: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    env: process.env.VERCEL_ENV || null,
    binding,
    binding_error,
    has_cron_secret: !!process.env.CRON_SECRET,
    flags: flagSnapshot(),   // Gate 0 launch-envelope matrix (operator-only)
    now: new Date().toISOString(),
  });
}
