// /api/site-admin — owner-only metrics + magic-link auth.
// Gated to a single email allowlist (david@demohubhq.com).
// Actions:
//   POST { action: 'login', email }                  -> magic-link sent if email is on allowlist; same response either way
//   POST { action: 'verify', token }                 -> returns session_id
//   POST { action: 'data', session_id }              -> aggregated metrics JSON
//   POST { action: 'logout', session_id }            -> kills session
//
// Sessions live in the existing admin_sessions table (retailer_id = NULL for owner sessions),
// so we don't add a new schema. Owner sessions are recognised by retailer_id IS NULL + email on allowlist.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Demohub <noreply@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';

// Allowlist — hardcoded. Add more emails here if needed.
const OWNER_EMAILS = ['david@demohubhq.com'];

// Pricing tiers — keep in sync with the marketing page.
const TIER_PRICES = { free: 0, starter: 79, growth: 199, enterprise: 499 };

function jsonResp(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function randomToken(n = 32) {
  const buf = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
}
async function verifyOwnerSession(sessionId) {
  if (!sessionId) return null;
  const r = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=email,retailer_id,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  if (!OWNER_EMAILS.includes((s.email || '').toLowerCase())) return null;
  return { email: s.email };
}

function ownerMagicLinkEmail(link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,sans-serif;color:#1c1c1a;">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:14px;padding:32px;border:1px solid rgba(15,44,23,0.08);">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:12px;">Owner sign in</div>
      <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#0f2c17;margin:0 0 12px;">Open the owner panel</h1>
      <p style="font-size:15px;line-height:1.5;color:#3a3a36;margin:0 0 22px;">Click below to sign in to the Demohub owner panel. Link expires in 30 minutes.</p>
      <a href="${html(link)}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 26px;border-radius:99px;text-decoration:none;font-weight:600;">Sign in &rarr;</a>
    </div>
  </body></html>`;
}

// --- helpers for the metrics aggregation ---
function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }
function startOfMonth(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); }

async function computeMetrics() {
  // Pull the broad collections we need. service_role bypasses RLS.
  const [retailersR, brandsR, demosR, bookingsR, settingsR] = await Promise.all([
    sb(`retailers?select=id,name,slug,created_at,logo_url,billing_email,billing_tier`),
    sb(`brands?select=id,company_name,created_at,default_coi_url,is_verified`),
    sb(`demos?select=id,retailer_id,brand_id,demo_date,demo_fee,status,created_at`),
    sb(`bookings?select=id,retailer_id,brand_id,status,created_at`),
    sb(`settings?select=retailer_id,billing_tier,price_per_demo`),
  ]);
  const retailers = await retailersR.json();
  const brands = await brandsR.json();
  const demos = await demosR.json();
  const bookings = await bookingsR.json();
  const settings = await settingsR.json();

  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = monthKey(lastMonthDate);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  // ---------- Headline ----------
  const totalRetailers = retailers.length;
  const totalBrands = brands.length;

  // Active retailers in last 30d = retailers with any demo or booking in last 30d
  const activeRetailerIds = new Set();
  demos.forEach(d => { if (d.created_at && new Date(d.created_at) >= thirtyDaysAgo) activeRetailerIds.add(d.retailer_id); });
  bookings.forEach(b => { if (b.created_at && new Date(b.created_at) >= thirtyDaysAgo) activeRetailerIds.add(b.retailer_id); });
  const activeRetailers30d = activeRetailerIds.size;

  // Demos this month vs last month (by demo_date)
  const demosThisMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === thisMonth).length;
  const demosLastMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === lastMonth).length;
  const demosDeltaPct = demosLastMonth === 0
    ? (demosThisMonth > 0 ? 100 : 0)
    : Math.round(((demosThisMonth - demosLastMonth) / demosLastMonth) * 100);

  // MRR projection: count each tier × tier price + per-demo revenue estimate (10% of demo fees this month)
  // Tier per retailer: settings.billing_tier OR retailers.billing_tier, default 'free'.
  const settingsByRetailer = {};
  settings.forEach(s => { settingsByRetailer[s.retailer_id] = s; });
  const tierCounts = { free: 0, starter: 0, growth: 0, enterprise: 0 };
  let mrrSubs = 0;
  retailers.forEach(r => {
    const tier = ((settingsByRetailer[r.id]?.billing_tier) || r.billing_tier || 'free').toLowerCase();
    if (tier in tierCounts) tierCounts[tier]++;
    mrrSubs += TIER_PRICES[tier] || 0;
  });
  // Per-demo revenue this month: $1 per $10 of demo fee.
  const perDemoRev = demos
    .filter(d => (d.demo_date || '').slice(0, 7) === thisMonth && (d.status === 'confirmed' || d.status === 'completed'))
    .reduce((s, d) => s + ((parseFloat(d.demo_fee) || 0) / 10), 0);
  const mrrProjection = Math.round(mrrSubs + perDemoRev);

  // ---------- Trends ----------
  // Last 12 months
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short' }) });
  }
  const retailerSignups = months.map(m => ({
    month: m.key, label: m.label,
    count: retailers.filter(r => (r.created_at || '').slice(0, 7) === m.key).length,
  }));
  const brandSignups = months.map(m => ({
    month: m.key, label: m.label,
    count: brands.filter(b => (b.created_at || '').slice(0, 7) === m.key).length,
  }));
  const demosPerMonth = months.map(m => ({
    month: m.key, label: m.label,
    count: demos.filter(d => (d.demo_date || '').slice(0, 7) === m.key).length,
  }));

  // ---------- Tables ----------
  // Top 10 retailers by demo volume this month
  const retailerDemoCount = {};
  demos.forEach(d => {
    if ((d.demo_date || '').slice(0, 7) !== thisMonth) return;
    retailerDemoCount[d.retailer_id] = (retailerDemoCount[d.retailer_id] || 0) + 1;
  });
  const retailerMap = Object.fromEntries(retailers.map(r => [r.id, r]));
  const topRetailers = Object.entries(retailerDemoCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([rid, count]) => ({ id: rid, name: retailerMap[rid]?.name || 'Unknown', slug: retailerMap[rid]?.slug || '', demos_this_month: count }));

  // Top 10 brands by activity (demos in last 30d)
  const brandActivity = {};
  demos.forEach(d => {
    if (!d.brand_id || !d.created_at || new Date(d.created_at) < thirtyDaysAgo) return;
    brandActivity[d.brand_id] = (brandActivity[d.brand_id] || 0) + 1;
  });
  const brandMap = Object.fromEntries(brands.map(b => [b.id, b]));
  const topBrands = Object.entries(brandActivity)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([bid, count]) => ({ id: bid, name: brandMap[bid]?.company_name || 'Unknown', activity_30d: count }));

  // Pending bookings stuck > 72h
  const pendingStuck = bookings
    .filter(b => b.status === 'pending' && b.created_at && new Date(b.created_at) < seventyTwoHoursAgo)
    .map(b => ({
      id: b.id,
      retailer_name: retailerMap[b.retailer_id]?.name || 'Unknown',
      retailer_slug: retailerMap[b.retailer_id]?.slug || '',
      brand_name: brandMap[b.brand_id]?.company_name || 'Unknown',
      created_at: b.created_at,
      hours_pending: Math.round((now - new Date(b.created_at)) / (60 * 60 * 1000)),
    }))
    .sort((a, b) => b.hours_pending - a.hours_pending)
    .slice(0, 20);

  // ---------- Watchlist ----------
  const brandsWithoutCoi = brands
    .filter(b => !b.default_coi_url)
    .slice(0, 25)
    .map(b => ({ id: b.id, name: b.company_name, created_at: b.created_at }));
  const dormantRetailers = retailers
    .filter(r => !activeRetailerIds.has(r.id))
    .slice(0, 25)
    .map(r => ({ id: r.id, name: r.name, slug: r.slug, last_active: null }));
  // Brands inactive > 60d (no demos in last 60d)
  const brandLastDemo = {};
  demos.forEach(d => {
    if (!d.brand_id) return;
    const c = d.created_at;
    if (!brandLastDemo[d.brand_id] || c > brandLastDemo[d.brand_id]) brandLastDemo[d.brand_id] = c;
  });
  const inactiveBrands = brands
    .filter(b => !brandLastDemo[b.id] || new Date(brandLastDemo[b.id]) < sixtyDaysAgo)
    .slice(0, 25)
    .map(b => ({ id: b.id, name: b.company_name, last_active: brandLastDemo[b.id] || null }));

  return {
    generated_at: new Date().toISOString(),
    headline: {
      total_retailers: totalRetailers,
      active_retailers_30d: activeRetailers30d,
      total_brands: totalBrands,
      demos_this_month: demosThisMonth,
      demos_last_month: demosLastMonth,
      demos_delta_pct: demosDeltaPct,
      mrr_projection: mrrProjection,
      mrr_subs: Math.round(mrrSubs),
      mrr_per_demo: Math.round(perDemoRev),
      tier_counts: tierCounts,
    },
    trends: {
      retailer_signups: retailerSignups,
      brand_signups: brandSignups,
      demos_per_month: demosPerMonth,
    },
    tables: {
      top_retailers: topRetailers,
      top_brands: topBrands,
      pending_stuck: pendingStuck,
    },
    watchlist: {
      brands_without_coi: brandsWithoutCoi,
      dormant_retailers: dormantRetailers,
      inactive_brands_60d: inactiveBrands,
    },
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!SERVICE_KEY) return jsonResp(res, 500, { error: 'SUPABASE_SERVICE_KEY not configured' });

  const body = await readBody(req);
  const action = (req.query?.action || body.action || '').toString();

  try {
    // ---- LOGIN: only sends email if address is on allowlist; same response either way ----
    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return jsonResp(res, 400, { error: 'Valid email required' });
      if (OWNER_EMAILS.includes(email)) {
        const token = randomToken(24);
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        // Reuse admin_tokens with retailer_id = NULL for owner tokens
        await sb('admin_tokens', {
          method: 'POST',
          body: JSON.stringify({ email, retailer_id: null, token, expires_at: expires }),
        });
        const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
        const link = `${origin}/owner?token=${encodeURIComponent(token)}`;
        if (RESEND_API_KEY) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: FROM_EMAIL, to: email, reply_to: REPLY_TO, subject: 'Sign in to the Demohub owner panel', html: ownerMagicLinkEmail(link) }),
            });
          } catch (_) { /* swallow */ }
        } else {
          console.log('OWNER MAGIC LINK:', link);
        }
      }
      return jsonResp(res, 200, { ok: true });
    }

    // ---- VERIFY ----
    if (action === 'verify') {
      const token = String(body.token || req.query?.t || '').trim();
      if (!token) return jsonResp(res, 400, { error: 'Missing token' });
      const tR = await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const tok = (await tR.json())[0];
      if (!tok) return jsonResp(res, 404, { error: 'Token not found' });
      if (tok.used_at) return jsonResp(res, 409, { error: 'Token already used' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 410, { error: 'Token expired' });
      if (!OWNER_EMAILS.includes((tok.email || '').toLowerCase())) return jsonResp(res, 403, { error: 'Not authorised' });

      await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessionR = await sb('admin_sessions', {
        method: 'POST',
        body: JSON.stringify({ email: tok.email, retailer_id: null }),
      });
      const session = (await sessionR.json())[0];
      return jsonResp(res, 200, { ok: true, session_id: session?.session_id, email: tok.email });
    }

    // ---- DATA: aggregated metrics ----
    if (action === 'data') {
      const sessionId = (req.query?.session_id || body.session_id || '').toString();
      const v = await verifyOwnerSession(sessionId);
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const metrics = await computeMetrics();
      return jsonResp(res, 200, { ok: true, ...metrics });
    }

    // ---- LOGOUT ----
    if (action === 'logout') {
      const sessionId = (req.query?.session_id || body.session_id || '').toString();
      if (sessionId) {
        try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch (_) {}
      }
      return jsonResp(res, 200, { ok: true });
    }

    return jsonResp(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('site-admin error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
