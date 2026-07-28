// api/version.js — build identity probe.
//
// R12-P1-5: the detailed view (Supabase project ref, Stripe live/test mode, secret-presence flags)
// is reconnaissance if exposed publicly, so it now requires the operator/deploy secret. Without it
// the endpoint returns only a coarse build id + health, which is safe to leave reachable in prod.
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || (req.headers['x-deploy-verify'] || '');
  const authed = !!CRON_SECRET && provided === CRON_SECRET;

  // public: nothing sensitive — short build id only, no env/config footprint
  if (!authed) {
    return res.status(200).json({
      ok: true,
      build: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      now: new Date().toISOString(),
    });
  }

  // operator view: full deployment identity + wiring flags (never secret VALUES)
  return res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    commit_short: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    env: process.env.VERCEL_ENV || null,
    has_supabase_url: !!process.env.SUPABASE_URL,
    supabase_host: (process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0] || null,
    has_service_key: !!process.env.SUPABASE_SERVICE_KEY,
    stripe_mode: (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_') ? 'test'
      : (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_') ? 'LIVE' : 'unset',
    has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
    has_cron_secret: !!process.env.CRON_SECRET,
    now: new Date().toISOString(),
  });
}
