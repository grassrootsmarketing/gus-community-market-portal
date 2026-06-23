// /api/brand-account
// Magic-link auth + profile CRUD for cross-retailer brand accounts.
// Actions: signup, login, verify, data, profile-update, demos, logout
// Privacy: NEVER expose brand_id to retailer-side endpoints. All retailer
// admin queries continue to filter by retailer_id only.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Demohub <noreply@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';

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
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
}
async function sendMagicLink(email, link, isNew) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY missing — printing link to logs'); console.log('MAGIC LINK:', link); return; }
  const subject = isNew ? 'Welcome to Demohub — verify your brand account' : 'Sign in to your Demohub brand account';
  const body = `
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c1c1a;">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 12px;">${isNew ? 'Welcome to Demohub.' : 'Sign in to your brand account.'}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;color:#3a3a36;">${isNew ? 'One profile that follows you to every Demohub retailer.' : 'Click below to access your dashboard.'} Link expires in 30 minutes.</p>
      <a href="${link}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 28px;border-radius:99px;text-decoration:none;font-weight:600;font-size:15px;">${isNew ? 'Verify and continue' : 'Sign in'}</a>
      <p style="font-size:13px;color:#6b6a64;margin-top:32px;">If you didn't request this, you can safely ignore the email.</p>
    </div>
  `;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: email, subject, html: body, reply_to: REPLY_TO }),
  });
}
async function verifySession(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s.brand_id;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const body = await readBody(req);
  const action = (req.query?.action || body.action || '').toString();

  try {
    // -------- SIGNUP: create brand + send magic link (anti-enum: same response either way) --------
    if (action === 'signup') {
      const email = String(body.email || '').trim().toLowerCase();
      const companyName = String(body.company_name || '').trim();
      const contactName = String(body.contact_name || '').trim() || null;
      const phone = String(body.phone || '').trim() || null;
      const website = String(body.website || '').trim() || null;
      const defaultCategories = String(body.default_categories || '').trim() || null;
      if (!email || !companyName) return jsonResp(res, 400, { error: 'Missing email or company_name' });

      // upsert by email
      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id`);
      const existing = (await lookupR.json())[0];
      let brandId;
      if (existing) {
        brandId = existing.id;
        // Fill in any newly-provided fields that weren't set before
        const patch = { updated_at: new Date().toISOString() };
        if (contactName) patch.contact_name = contactName;
        if (phone) patch.phone = phone;
        if (website) patch.website = website;
        if (defaultCategories) patch.default_categories = defaultCategories;
        try { await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (_) {}
      } else {
        const createR = await sb('brands', {
          method: 'POST',
          body: JSON.stringify({ email, company_name: companyName, contact_name: contactName, phone, website, default_categories: defaultCategories }),
        });
        const created = await createR.json();
        if (!Array.isArray(created) || !created[0]) return jsonResp(res, 500, { error: 'Failed to create brand' });
        brandId = created[0].id;
      }

      // create magic link token
      const token = randomToken(24);
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await sb('brand_account_tokens', {
        method: 'POST',
        body: JSON.stringify({ brand_id: brandId, token, expires_at: expires }),
      });
      const link = `https://demohubhq.com/brand/verify?t=${token}`;
      await sendMagicLink(email, link, !existing);
      return jsonResp(res, 200, { ok: true });
    }

    // -------- LOGIN: existing brand (anti-enum: same response if email unknown) --------
    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return jsonResp(res, 400, { error: 'Missing email' });
      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id`);
      const existing = (await lookupR.json())[0];
      if (existing) {
        const token = randomToken(24);
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: existing.id, token, expires_at: expires }),
        });
        const link = `https://demohubhq.com/brand/verify?t=${token}`;
        await sendMagicLink(email, link, false);
      }
      // Always return ok to avoid revealing whether email is registered
      return jsonResp(res, 200, { ok: true });
    }

    // -------- VERIFY: exchange magic-link token for session --------
    if (action === 'verify') {
      const token = String(body.token || req.query?.t || '').trim();
      if (!token) return jsonResp(res, 400, { error: 'Missing token' });
      const tR = await sb(`brand_account_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const tok = (await tR.json())[0];
      if (!tok || tok.used_at) return jsonResp(res, 401, { error: 'Invalid or used token' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 401, { error: 'Token expired' });
      // mark used
      await sb(`brand_account_tokens?id=eq.${tok.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used_at: new Date().toISOString() }),
      });
      // create session
      const sessionToken = randomToken(32);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: tok.brand_id, session_token: sessionToken, expires_at: expires }),
      });
      // mark brand verified
      await sb(`brands?id=eq.${tok.brand_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_verified: true, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, session_token: sessionToken });
    }

    // -------- DATA: fetch brand profile + all demos across retailers --------
    if (action === 'data') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });

      const [profileR, demosR] = await Promise.all([
        sb(`brands?id=eq.${brandId}&select=*`),
        sb(`demos?brand_id=eq.${brandId}&select=*,retailers(id,name,slug),venues(id,name,address)&order=demo_date.desc`),
      ]);
      const profile = (await profileR.json())[0] || null;
      const demos = await demosR.json();
      return jsonResp(res, 200, { profile, demos });
    }

    // -------- PROFILE-UPDATE: brand edits their own profile --------
    if (action === 'profile-update') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });

      const allowed = ['company_name', 'contact_name', 'phone', 'default_coi_url', 'default_coi_expires', 'default_product_info', 'default_categories', 'website'];
      const patch = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
      }
      const r = await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!r.ok) return jsonResp(res, 500, { error: 'Failed to update' });
      return jsonResp(res, 200, { ok: true });
    }

    // -------- LOGOUT --------
    if (action === 'logout') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      if (sessionToken) {
        await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}`, { method: 'DELETE' });
      }
      return jsonResp(res, 200, { ok: true });
    }

    return jsonResp(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('brand-account error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
