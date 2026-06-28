// /api/stripe — Subscription management for retailers.
// Actions: subscribe, portal, cancel, status
//
// Auth: requires a valid admin session_id (verifies retailer scope).
// Stripe: products are looked up by metadata.tier; the price for the
// requested billing_interval (month|year) is used in checkout.
//
// Env required:
//   STRIPE_SECRET_KEY     (sk_test_... or sk_live_...)
//   SUPABASE_SERVICE_KEY

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://demohubhq.com';

const VALID_TIERS = new Set(['solo', 'starter', 'growth', 'enterprise']);
const VALID_INTERVALS = new Set(['month', 'year']);

// ----- helpers -----
function jsonResp(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').send(JSON.stringify(body));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

async function sb(path, opts = {}) {
  const headers = {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// Stripe API: form-urlencoded request bodies. Helper flattens nested keys.
function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      parts.push(formEncode(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        if (typeof item === 'object') parts.push(formEncode(item, `${key}[${idx}]`));
        else parts.push(`${encodeURIComponent(`${key}[${idx}]`)}=${encodeURIComponent(item)}`);
      });
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

async function stripe(method, path, body) {
  const headers = { Authorization: `Basic ${Buffer.from(STRIPE_SECRET_KEY + ':').toString('base64')}` };
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = formEncode(body);
  }
  const r = await fetch(`https://api.stripe.com${path}`, opts);
  const json = await r.json();
  if (!r.ok) throw new Error(json.error?.message || `Stripe ${r.status}`);
  return json;
}

async function verifySession(session_id) {
  if (!session_id || !isUuid(session_id)) return null;
  try {
    const arr = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(arr) ? arr[0] : null;
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    return s;
  } catch (_) { return null; }
}

// ----- price/product lookup (cached in-memory per cold start) -----
let _priceCache = null;
async function getPriceForTier(tier, interval) {
  if (!_priceCache) {
    const r = await stripe('GET', `/v1/prices?limit=100&active=true&expand[]=data.product`);
    _priceCache = r.data.filter(p => p.product?.metadata?.platform === 'demohub' && p.product?.metadata?.tier);
  }
  const match = _priceCache.find(p =>
    p.product.metadata.tier === tier &&
    p.recurring?.interval === interval
  );
  return match || null;
}

// ----- handler -----
export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
    if (!STRIPE_SECRET_KEY) return jsonResp(res, 500, { error: 'STRIPE_SECRET_KEY not configured' });
    if (!SERVICE_KEY) return jsonResp(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = (req.query?.action || body.action || '').toString();
    const session_id = (req.query?.session_id || body.session_id || '').toString();

    const session = await verifySession(session_id);
    if (!session) return jsonResp(res, 401, { error: 'Not authenticated' });

    const retailerArr = await sb(`retailers?id=eq.${encodeURIComponent(session.retailer_id)}&select=*`);
    const retailer = Array.isArray(retailerArr) ? retailerArr[0] : null;
    if (!retailer) return jsonResp(res, 404, { error: 'Retailer not found' });

    // ---- subscribe: create Checkout Session for a tier subscription ----
    if (action === 'subscribe') {
      const tier = (body.tier || '').toString();
      const interval = (body.interval || 'month').toString();
      if (!VALID_TIERS.has(tier)) return jsonResp(res, 400, { error: 'Invalid tier' });
      if (!VALID_INTERVALS.has(interval)) return jsonResp(res, 400, { error: 'Invalid interval' });

      const price = await getPriceForTier(tier, interval);
      if (!price) return jsonResp(res, 500, { error: `No price found for ${tier}/${interval}. Check Stripe products.` });

      // Ensure Stripe customer exists for this retailer
      let customerId = retailer.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe('POST', '/v1/customers', {
          email: retailer.billing_email,
          name: retailer.name,
          metadata: { retailer_id: retailer.id, retailer_slug: retailer.slug || '' },
        });
        customerId = customer.id;
        await sb(`retailers?id=eq.${encodeURIComponent(retailer.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ stripe_customer_id: customerId }),
        });
      }

      const returnUrl = `${SITE_ORIGIN}/r/${retailer.slug || 'gus'}/admin?billing=success`;
      const cancelUrl = `${SITE_ORIGIN}/r/${retailer.slug || 'gus'}/admin?billing=canceled`;
      const checkout = await stripe('POST', '/v1/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: price.id, quantity: 1 }],
        success_url: returnUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
        subscription_data: {
          trial_period_days: 14,
          metadata: { retailer_id: retailer.id, tier, interval },
        },
        metadata: { retailer_id: retailer.id, tier, interval },
      });
      return jsonResp(res, 200, { url: checkout.url, session_id: checkout.id });
    }

    // ---- portal: open Stripe Customer Portal for managing subscription ----
    if (action === 'portal') {
      if (!retailer.stripe_customer_id) {
        return jsonResp(res, 400, { error: 'No Stripe customer on file. Subscribe to a plan first.' });
      }
      const returnUrl = `${SITE_ORIGIN}/r/${retailer.slug || 'gus'}/admin?billing=managed`;
      const portal = await stripe('POST', '/v1/billing_portal/sessions', {
        customer: retailer.stripe_customer_id,
        return_url: returnUrl,
      });
      return jsonResp(res, 200, { url: portal.url });
    }

    // ---- cancel: cancel subscription at period end ----
    if (action === 'cancel') {
      if (!retailer.stripe_subscription_id) {
        return jsonResp(res, 400, { error: 'No active subscription to cancel.' });
      }
      const updated = await stripe('POST', `/v1/subscriptions/${retailer.stripe_subscription_id}`, {
        cancel_at_period_end: true,
      });
      return jsonResp(res, 200, {
        ok: true,
        cancel_at: updated.cancel_at ? new Date(updated.cancel_at * 1000).toISOString() : null,
        current_period_end: updated.current_period_end ? new Date(updated.current_period_end * 1000).toISOString() : null,
      });
    }

    // ---- status: read current billing state for the retailer ----
    if (action === 'status') {
      return jsonResp(res, 200, {
        tier: retailer.billing_tier || null,
        status: retailer.billing_status || null,
        interval: retailer.billing_period_interval || null,
        period_end: retailer.billing_period_end || null,
        has_subscription: !!retailer.stripe_subscription_id,
        has_customer: !!retailer.stripe_customer_id,
      });
    }

    // ---- connect-onboard: create Stripe Connect Express account + onboarding link ----
    if (action === 'connect-onboard') {
      // Create the account if we don't already have one for this retailer
      let acctId = retailer.stripe_account_id;
      if (!acctId) {
        const acct = await stripe('POST', '/v1/accounts', {
          type: 'express',
          country: 'US',
          email: retailer.billing_email,
          business_type: 'company',
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          business_profile: {
            name: retailer.name,
            mcc: '5499', // Grocery / specialty foods
            url: 'https://demohubhq.com/r/' + (retailer.slug || ''),
            product_description: 'In-store brand demo coordination',
          },
          metadata: { retailer_id: retailer.id, retailer_slug: retailer.slug || '' },
        });
        acctId = acct.id;
        await sb(`retailers?id=eq.${encodeURIComponent(retailer.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ stripe_account_id: acctId, stripe_account_status: 'pending' }),
        });
      }
      const baseUrl = `${SITE_ORIGIN}/r/${retailer.slug || 'gus'}/admin`;
      const link = await stripe('POST', '/v1/account_links', {
        account: acctId,
        refresh_url: baseUrl + '?connect=refresh',
        return_url: baseUrl + '?connect=return',
        type: 'account_onboarding',
      });
      return jsonResp(res, 200, { url: link.url, account_id: acctId });
    }

    // ---- connect-dashboard: get Express dashboard login link for an onboarded retailer ----
    if (action === 'connect-dashboard') {
      if (!retailer.stripe_account_id) return jsonResp(res, 400, { error: 'Not connected to Stripe yet.' });
      const link = await stripe('POST', `/v1/accounts/${encodeURIComponent(retailer.stripe_account_id)}/login_links`, {});
      return jsonResp(res, 200, { url: link.url });
    }

    // ---- connect-status: re-fetch latest account state from Stripe + sync to DB ----
    if (action === 'connect-status') {
      if (!retailer.stripe_account_id) {
        return jsonResp(res, 200, {
          connected: false,
          charges_enabled: false,
          payouts_enabled: false,
        });
      }
      const acct = await stripe('GET', `/v1/accounts/${encodeURIComponent(retailer.stripe_account_id)}`);
      const charges = !!acct.charges_enabled;
      const payouts = !!acct.payouts_enabled;
      const status = charges && payouts ? 'active' : (acct.requirements?.disabled_reason ? 'restricted' : 'pending');
      await sb(`retailers?id=eq.${encodeURIComponent(retailer.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          stripe_charges_enabled: charges,
          stripe_payouts_enabled: payouts,
          stripe_account_status: status,
        }),
      });
      return jsonResp(res, 200, {
        connected: true,
        charges_enabled: charges,
        payouts_enabled: payouts,
        status,
        requirements: acct.requirements?.currently_due || [],
      });
    }

    return jsonResp(res, 400, { error: 'Unknown action. Use subscribe, portal, cancel, status, connect-onboard, connect-dashboard, or connect-status.' });
  } catch (e) {
    console.error('stripe.js error:', e);
    return jsonResp(res, 500, { error: String(e?.message || e) });
  }
}
