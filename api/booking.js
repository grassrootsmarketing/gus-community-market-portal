// /api/booking — Vercel serverless function
// Writes a booking row to Supabase and sends a confirmation email via Resend.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_KEY = 'sb_publishable__e8tiRc5-f7Wexa-r1Perg_hJ84vltF';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

const DEFAULT_DEMO_POLICY = 'Arrive 15 minutes before your slot to set up. Bring your own sampling supplies (cups, napkins, ice if needed). Coordinate with the floor lead on arrival. Keep the demo area clean, present products in branded packaging only, and break down promptly at end of slot. No solicitation outside the demo area.';
const DEFAULT_CANCELLATION_POLICY = 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules are welcome anytime.';
// Wave 7: include Demohub TOS in agreement scope (and hash) so brand explicitly
// agrees to platform terms each time the conduct contract is signed.
const DEMOHUB_TOS_VERSION = '2026-06-29';
const DEMOHUB_TOS_URL = 'https://www.demohubhq.com/terms';

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str || '');
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function svcCall(path, opts = {}) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY not configured for write');
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// -----------------------------------------------------------------------------
// Rate limiting — fail-closed (denies on DB errors to prevent abuse during blips)
// -----------------------------------------------------------------------------
function clientIpForRateLimit(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-real-ip']
    || (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

async function checkRateLimitStrict(req, bucketKey, maxPerHour) {
  try {
    const ip = clientIpForRateLimit(req);
    const key = bucketKey + ':' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existing = await svcCall(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false, current: row.count };
    if (row) {
      await svcCall(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    } else {
      await svcCall('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    }
    return { allowed: true, current: (row ? row.count : 0) + 1 };
  } catch (e) {
    // Fail-CLOSED: on rate-limiter errors, deny the write so a Supabase blip cannot
    // become an unbounded spam window. Callers must handle 503 gracefully.
    console.error('rate limit check failed — denying request:', e?.message || e);
    return { allowed: false, current: 0, error: 'rate_limit_unavailable' };
  }
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
}

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function emailBody({ contact_name, brand_name, product, venue, demo_date, demo_time, dateLabel, retailerName, cancellationPolicy }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td>
<td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo booking received</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Thanks${contact_name ? ', ' + html(contact_name) : ''}!</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 24px;">We've received your demo request for <strong style="color:#0f2c17;">${html(retailerName)}</strong>. The store team will reach out within one business day to confirm.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:24px;">
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:14px 18px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(brand_name)}</td></tr>
${product ? `<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(product)}</td></tr>` : ''}
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Location</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(venue)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(dateLabel)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(demo_time)}</td></tr>
</table>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0 0 18px;">Need to change something? Just reply to this email — it goes straight to the store team.</p>
${cancellationPolicy ? `<div style="background:#fbf7f0;border-left:3px solid #ed682f;padding:14px 18px;border-radius:6px;margin-top:8px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#a14e2a;font-weight:700;margin-bottom:6px;">Cancellation policy</div><div style="font-size:13px;line-height:1.55;color:#3a3a36;">${html(cancellationPolicy)}</div></div>` : ''}
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> · demohubhq.com</td></tr>
</table></body></html>`;
}

// Wave 9: error log — best-effort write to error_log on any 5xx return.
// Caller uses logError(req, e, status). Never throws.
async function logError(req, status, message, stack) {
  if (!SERVICE_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: '/api/booking',
        method: req.method || 'POST',
        status_code: status,
        message: String(message || '').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        request_meta: { url: req.url, action: (() => { try { return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}).action || null; } catch(_) { return null; } })() },
      }),
    });
  } catch (_) {}
}


export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // ---- Agreement check (folded in to stay under Vercel function cap) ----
    // Public — called by the booking page before submit to decide whether to show
    // the demo-conduct modal. Returns { has_active, needs_re_sign, reason, policies }.
    if (body?.action === 'agreement-check') {
      const { brand_email, retailer_slug: rs } = body;
      if (!rs) return res.status(400).json({ error: 'retailer_slug required' });
      const retResp = await fetch(`${SUPABASE_URL}/rest/v1/retailers?slug=eq.${encodeURIComponent(rs)}&select=id,name,demo_policy,cancellation_policy`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const rets = await retResp.json();
      const ret = Array.isArray(rets) ? rets[0] : null;
      if (!ret) return res.status(404).json({ error: 'Retailer not found' });
      const dp = ret.demo_policy || DEFAULT_DEMO_POLICY;
      const cp = ret.cancellation_policy || DEFAULT_CANCELLATION_POLICY;
      const curHash = await sha256Hex(dp + '\n---\n' + cp + '\n---tos:' + DEMOHUB_TOS_VERSION);
      const policies = {
        demo_policy: dp,
        cancellation_policy: cp,
        policy_hash: curHash,
        retailer_name: ret.name,
        demohub_tos_version: DEMOHUB_TOS_VERSION,
        demohub_tos_url: DEMOHUB_TOS_URL,
      };
      if (!brand_email) return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'no_email', policies });
      const brResp = await fetch(`${SUPABASE_URL}/rest/v1/brands?email=eq.${encodeURIComponent(String(brand_email).toLowerCase())}&select=id`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const brs = await brResp.json();
      const br = Array.isArray(brs) ? brs[0] : null;
      if (!br) return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'no_brand_account', policies });
      // Active agreement?
      const aResp = await fetch(`${SUPABASE_URL}/rest/v1/brand_retailer_agreements?brand_id=eq.${encodeURIComponent(br.id)}&retailer_id=eq.${encodeURIComponent(ret.id)}&superseded_at=is.null&select=*&order=signed_at.desc&limit=1`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const as = await aResp.json();
      const a = Array.isArray(as) ? as[0] : null;
      if (!a) return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'never_signed', policies });
      if (new Date(a.expires_at).getTime() < Date.now()) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'expired', current_agreement: a, policies });
      }
      if (a.policy_hash !== curHash) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'policy_changed', current_agreement: a, policies });
      }
      return res.status(200).json({ ok: true, has_active: true, needs_re_sign: false, current_agreement: a, policies });
    }

    const { retailer_slug, brand_name, contact_name, contact_email, contact_phone, product, venue, demo_date, demo_time, notes, signed_name } = body || {};

    if (!contact_email || !brand_name || !venue || !demo_date || !demo_time || !retailer_slug) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ---- Rate limit: prevent booking spam against any single retailer or from any single brand email ----
    const rlSlug = await checkRateLimitStrict(req, 'booking-slug:' + String(retailer_slug).slice(0, 32), 20);
    if (!rlSlug.allowed) {
      const isBlip = rlSlug.error === 'rate_limit_unavailable';
      return res.status(isBlip ? 503 : 429).json({
        error: isBlip ? 'rate_limit_unavailable' : 'too_many_bookings',
        message: isBlip ? 'Try again in a moment.' : 'Too many booking attempts. Try again in an hour.',
      });
    }
    const rlEmail = await checkRateLimitStrict(req, 'booking-email:' + String(contact_email).toLowerCase().slice(0, 64), 5);
    if (!rlEmail.allowed) {
      const isBlip = rlEmail.error === 'rate_limit_unavailable';
      return res.status(isBlip ? 503 : 429).json({
        error: isBlip ? 'rate_limit_unavailable' : 'too_many_bookings',
        message: isBlip ? 'Try again in a moment.' : 'Too many bookings from this email in the last hour.',
      });
    }

    // Look up retailer by slug, get id, name, and cancellation policy
    const retailerResp = await fetch(`${SUPABASE_URL}/rest/v1/retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name,cancellation_policy,demo_policy,billing_email,auto_confirm_bookings,cancellation_mode`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const retailers = await retailerResp.json();
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'Retailer not found' });
    const RETAILER_ID = retailer.id;
    const RETAILER_NAME = retailer.name;
    const RETAILER_BILLING_EMAIL = retailer.billing_email || null;
    const CANCELLATION_POLICY = retailer.cancellation_policy || '';

    // Look up venue by retailer + name (for venue_id on the row)
    const venueResp = await fetch(`${SUPABASE_URL}/rest/v1/venues?retailer_id=eq.${encodeURIComponent(RETAILER_ID)}&name=eq.${encodeURIComponent(venue)}&select=id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const venues = await venueResp.json();
    const venueRow = Array.isArray(venues) ? venues[0] : null;

    // Auto-link to a brand account if email matches an existing brand
    // (cross-retailer brand profiles — the brand sees this in /brand/dashboard)
    let brandId = null;
    try {
      const brandLookup = await fetch(`${SUPABASE_URL}/rest/v1/brands?email=eq.${encodeURIComponent(String(contact_email).toLowerCase())}&select=id`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
      const brandRows = await brandLookup.json();
      brandId = Array.isArray(brandRows) && brandRows[0] ? brandRows[0].id : null;
    } catch (_) { /* non-fatal */ }

    // ---- Demo conduct contract: capture or refresh the brand × retailer agreement ----
    // If the brand provided a typed signature in the booking payload, lock it in.
    // For first-time brands (no brand row yet) we minimally create one so we have a
    // foreign key target for the agreement. Bookings continue regardless if any of
    // this fails — agreement is best-effort, the booking is the primary action.
    const DEMO_POLICY = retailer.demo_policy || DEFAULT_DEMO_POLICY;
    const CURRENT_CANCEL_POLICY = retailer.cancellation_policy || DEFAULT_CANCELLATION_POLICY;
    if (signed_name && String(signed_name).trim().length >= 2 && SERVICE_KEY) {
      try {
        // Ensure we have a brand row
        if (!brandId) {
          const created = await svcCall('brands', {
            method: 'POST',
            body: JSON.stringify({
              email: String(contact_email).toLowerCase(),
              name: brand_name || null,
              company_name: brand_name || null,
              contact_name: contact_name || null,
              phone: contact_phone || null,
            }),
          });
          brandId = Array.isArray(created) ? created[0]?.id : null;
        }
        if (brandId) {
          const policyHash = await sha256Hex(DEMO_POLICY + '\n---\n' + CURRENT_CANCEL_POLICY + '\n---tos:' + DEMOHUB_TOS_VERSION);
          // Supersede any prior active agreement for this brand × retailer
          const existing = await svcCall(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brandId)}&retailer_id=eq.${encodeURIComponent(RETAILER_ID)}&superseded_at=is.null&select=id`);
          const priorId = Array.isArray(existing) && existing[0] ? existing[0].id : null;
          if (priorId) {
            await svcCall(`brand_retailer_agreements?id=eq.${encodeURIComponent(priorId)}`, {
              method: 'PATCH',
              body: JSON.stringify({ superseded_at: new Date().toISOString() }),
            });
          }
          const newAgreement = await svcCall('brand_retailer_agreements', {
            method: 'POST',
            body: JSON.stringify({
              brand_id: brandId,
              retailer_id: RETAILER_ID,
              signed_name: String(signed_name).trim(),
              signed_email: String(contact_email).toLowerCase(),
              signed_ip: clientIp(req),
              signed_user_agent: req.headers['user-agent'] || null,
              demo_policy_snapshot: DEMO_POLICY,
              cancellation_policy_snapshot: CURRENT_CANCEL_POLICY,
              policy_hash: policyHash,
            }),
          });
          if (priorId && Array.isArray(newAgreement) && newAgreement[0]?.id) {
            try {
              await svcCall(`brand_retailer_agreements?id=eq.${encodeURIComponent(priorId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ superseded_by: newAgreement[0].id }),
              });
            } catch (_) {}
          }

          // Wave 7: email the brand a receipt of what they just signed.
          // Best-effort — does not block the booking flow if Resend is unavailable.
          try {
            const RESEND = process.env.RESEND_API_KEY;
            if (RESEND && Array.isArray(newAgreement) && newAgreement[0]) {
              const a = newAgreement[0];
              const signedDate = new Date(a.signed_at).toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
              const expiresDate = new Date(a.expires_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
              const subj = `Receipt: your demo conduct agreement with ${RETAILER_NAME}`;
              const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;"><svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg></td>
<td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 36px 12px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">Agreement signed</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">Thanks ${html(signed_name)}.</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">This is a receipt of the demo conduct agreement you just signed with <strong style="color:#0f2c17;">${html(RETAILER_NAME)}</strong> through Demohub. Keep this for your records.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Signed as</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(signed_name)}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Signed on</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${signedDate}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Valid through</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${expiresDate}</td></tr>
</table>
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#a14e2a;margin:18px 0 8px;">Demo policy you agreed to</div>
<div style="background:#fbf7f0;border-left:3px solid #ed682f;padding:14px 18px;border-radius:6px;font-size:13px;line-height:1.6;color:#3a3a36;white-space:pre-wrap;margin-bottom:18px;">${html(DEMO_POLICY)}</div>
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#a14e2a;margin:18px 0 8px;">Cancellation policy you agreed to</div>
<div style="background:#fbf7f0;border-left:3px solid #ed682f;padding:14px 18px;border-radius:6px;font-size:13px;line-height:1.6;color:#3a3a36;white-space:pre-wrap;margin-bottom:18px;">${html(CURRENT_CANCEL_POLICY)}</div>
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:18px 0 0;">You also agreed to <a href="${DEMOHUB_TOS_URL}" style="color:#2a5b32;">Demohub's Terms of Service</a> (version ${DEMOHUB_TOS_VERSION}) as part of this agreement.</p>
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:18px 0 0;">If you ever need this agreement again, your <a href="https://www.demohubhq.com/brand/dashboard" style="color:#2a5b32;">Demohub brand portal</a> has a copy under Agreements.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: FROM_ADDRESS,
                  to: String(contact_email).toLowerCase(),
                  reply_to: 'david@demohubhq.com',
                  subject: subj,
                  html: htmlBody,
                }),
              });

              // Send a parallel copy to the retailer so they have an audit trail too.
              // Different subject so it's distinguishable in their inbox.
              if (RETAILER_BILLING_EMAIL) {
                const retailerSubj = `New agreement signed: ${signed_name} (${brand_name || 'unknown brand'})`;
                const retailerHtmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;"><svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg></td>
<td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 36px 12px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">Brand signed your conduct agreement</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">A new agreement is on file.</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;"><strong style="color:#0f2c17;">${html(brand_name || 'A brand')}</strong> just signed your demo conduct &amp; cancellation policies as part of booking. Both sides now have a record of what was agreed to.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(brand_name || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Signed by</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(signed_name)} &lt;${html(String(contact_email).toLowerCase())}&gt;</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Signed on</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${signedDate}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Valid through</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${expiresDate}</td></tr>
</table>
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">You can view this agreement (and all signed agreements with brands) in your admin under <strong>Brands</strong> &mdash; each brand shows an &ldquo;Agreement &check;&rdquo; pill once they&apos;ve signed.</p>
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0;">If you change your demo or cancellation policy text, this brand will be re-prompted to sign before their next booking.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    from: FROM_ADDRESS,
                    to: RETAILER_BILLING_EMAIL,
                    reply_to: 'david@demohubhq.com',
                    subject: retailerSubj,
                    html: retailerHtmlBody,
                  }),
                });
              }
            }
          } catch (e) { console.warn('agreement email skipped:', e?.message || e); }
        }
      } catch (e) {
        console.warn('agreement capture skipped:', e?.message || e);
      }
    }

    // Insert booking row
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/bookings`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        // Auto-confirm if the retailer opted in - skips the manual pending step,
        // brand gets a confirmation email immediately.
        // (Manual retailers keep the pending flow so they can vet each request.)
        retailer_id: RETAILER_ID,
        venue_id: venueRow ? venueRow.id : null,
        brand_name,
        contact_name: contact_name || null,
        contact_email,
        contact_phone: contact_phone || null,
        product: product || null,
        demo_date,
        demo_time,
        notes: notes || null,
        status: (retailer.auto_confirm_bookings ? 'confirmed' : 'pending'),
        brand_id: brandId,
      }),
    });

    if (!insertResp.ok) {
      const detail = await insertResp.text();
      return res.status(502).json({ error: 'DB insert failed', detail });
    }
    const inserted = await insertResp.json();
    const bookingId = Array.isArray(inserted) ? inserted[0]?.id : null;

    // Send confirmation email
    const dateLabel = new Date(demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    let emailOk = false;
    let emailErr = null;

    if (!RESEND_API_KEY) {
      emailErr = 'RESEND_API_KEY not configured on server';
    } else {
      const emailResp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: contact_email,
          reply_to: 'david@demohubhq.com',
          subject: `Demo request received — ${RETAILER_NAME}`,
          html: emailBody({ contact_name, brand_name, product, venue, demo_date, demo_time, dateLabel, retailerName: RETAILER_NAME, cancellationPolicy: CANCELLATION_POLICY }),
        }),
      });
      emailOk = emailResp.ok;
      if (!emailOk) {
        try { const j = await emailResp.json(); emailErr = j.message || JSON.stringify(j); } catch (_) { emailErr = `HTTP ${emailResp.status}`; }
      }
    }


    // ===== Wave 8: Notify assigned store staff (internal_contacts) =====
    // Only fires for staff with notification_prefs.on_scheduled=true AND venue_ids empty (all stores)
    // OR venue_ids contains the booked venue. Idempotent-ish: booking has bookings.id which is unique.
    // Best-effort — doesn't block booking success.
    try {
      const RESEND_KEY = process.env.RESEND_API_KEY;
      if (RESEND_KEY && bookingId) {
        // Fetch staff whose prefs include on_scheduled and either no venue restriction or this venue
        const bookedVenueId = venue?.id || null;
        const staffUrl = `${SUPABASE_URL}/rest/v1/internal_contacts?retailer_id=eq.${encodeURIComponent(RETAILER_ID)}&select=id,name,email,notification_prefs,venue_ids`;
        const staffResp = await fetch(staffUrl, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
        if (staffResp.ok) {
          const allStaff = await staffResp.json();
          const targetStaff = (allStaff || []).filter(s => {
            const prefs = s.notification_prefs || {};
            if (!prefs.on_scheduled) return false;
            const scopes = Array.isArray(s.venue_ids) ? s.venue_ids : [];
            if (scopes.length === 0) return true; // no venue restriction = notify for all
            if (bookedVenueId && scopes.includes(bookedVenueId)) return true;
            return false;
          }).filter(s => s.email);

          if (targetStaff.length > 0) {
            const staffSubj = `New demo scheduled: ${brand_name || 'a brand'} on ${dateLabel}`;
            const staffHtml = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<div style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</div>
</td></tr>
<tr><td style="padding:32px 36px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">New demo scheduled</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">A demo just landed on your calendar.</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Make sure you've got enough product on hand — <strong>${html(brand_name || 'the brand')}</strong> is coming to demo <strong>${html(product || 'their product')}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(brand_name || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(product || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${dateLabel}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(demo_time || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Location</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(venue?.name || '—')}</td></tr>
</table>
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">You're receiving this because <strong style="color:#0f2c17;">${html(RETAILER_NAME)}</strong> added you to their team with new-demo alerts on.</p>
<p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:0;"><a href="https://demohubhq.com/r/${retailer_slug}/admin" style="color:#2a5b32;">View full booking &rarr;</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; This is an automated staff alert. Adjust who gets these in your admin under Team.</td></tr>
</table></body></html>`;
            // Fire one email per staff member (Resend handles up to 100/sec)
            await Promise.allSettled(targetStaff.map(s => fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: FROM_ADDRESS,
                to: s.email,
                reply_to: 'david@demohubhq.com',
                subject: staffSubj,
                html: staffHtml,
              }),
            })));
            console.log(`staff-notify: sent to ${targetStaff.length} staff for booking ${bookingId}`);
          }
        }
      }
    } catch (staffErr) {
      console.warn('staff-notify error (non-blocking):', staffErr?.message || staffErr);
    }


    return res.status(200).json({ success: true, booking_id: bookingId, email_sent: emailOk, email_error: emailErr });
  } catch (e) {
    await logError(req, 500, e?.message || e, e?.stack);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
