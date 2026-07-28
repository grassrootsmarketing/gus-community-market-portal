// api/version.js — build identity probe. Lets us verify exactly which commit a deployment is
// running (Vercel deployment URLs don't reveal this, and redeploying the wrong build silently
// serves stale code). Returns no secrets: commit sha, branch, environment, build time.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    commit_short: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    env: process.env.VERCEL_ENV || null,
    // presence-only flags (never the values) so we can confirm preview wiring at a glance
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
