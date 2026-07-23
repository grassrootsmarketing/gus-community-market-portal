// api/_env.js — F5-00: required-environment validation and production-safety guard.
// No production fallbacks: a missing critical variable fails CLOSED (throws) so a
// misconfigured deploy errors loudly instead of silently using production resources.

function req(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
function opt(name) { const v = process.env[name]; return v && String(v).trim() ? v : null; }

// Call inside a handler (not at import time) so a build can't crash; fails closed at request time.
export function getConfig() {
  return {
    SUPABASE_URL: req('SUPABASE_URL'),
    SUPABASE_SERVICE_KEY: req('SUPABASE_SERVICE_KEY'),
    SITE_ORIGIN: req('SITE_ORIGIN'),
    STRIPE_SECRET_KEY: opt('STRIPE_SECRET_KEY'),
    STRIPE_WEBHOOK_SECRET: opt('STRIPE_WEBHOOK_SECRET'),
    RESEND_API_KEY: opt('RESEND_API_KEY'),
    CRON_SECRET: opt('CRON_SECRET'),
    VERCEL_ENV: opt('VERCEL_ENV'),
  };
}

// The one production Supabase host. Destructive/reconciliation/test code must refuse to touch it.
export const PROD_SUPABASE_HOST = 'ecapmcyumpjjgjwuokyv.supabase.co';

// F5-00: machine-readable guard. Any destructive or reconciliation routine calls this first.
export function assertNotProduction() {
  const url = String(process.env.SUPABASE_URL || '');
  if (url.includes(PROD_SUPABASE_HOST)) {
    throw new Error('SAFETY: refusing to run destructive/test code against the PRODUCTION Supabase project.');
  }
  if (String(process.env.VERCEL_ENV || '') === 'production') {
    throw new Error('SAFETY: refusing to run destructive/test code in the PRODUCTION environment.');
  }
  return true;
}
