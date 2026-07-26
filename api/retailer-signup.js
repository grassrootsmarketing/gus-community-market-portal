// api/retailer-signup.js — F5-03: verified, transactional self-serve retailer signup.
// Flow: request a code (proves email ownership) -> verify the code -> ONLY THEN provision a
// free Solo retailer + owner membership + session. No account/session before email proof.
// Paid tiers (pro/enterprise) are a separate upgrade; signup always creates a free Solo store.

import crypto from 'node:crypto';
import { createChallenge, consumeChallenge } from './_verify.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.demohubhq.com';

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
// Set the same HttpOnly session cookie admin-auth.js issues, so a freshly
// verified owner lands in their admin already logged in (no token in the URL).
function setSessionCookie(res, sessionId) {
  const cookie = `dh_session=${encodeURIComponent(sessionId)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}
function slugify(s) {
  return String(s || 'store').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'store';
}
async function uniqueSlug(base) {
  let slug = base;
  for (let i = 0; i < 25; i++) {
    const r = await rest(`retailers?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`);
    const rows = r.ok ? await r.json() : [];
    if (!rows.length) return slug;
    slug = `${base}-${crypto.randomInt(100, 999)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// The provisioning step — runs only after email is proven. Exported so it's testable.
export async function provisionVerifiedRetailer(email, storeName) {
  const e = String(email).trim().toLowerCase();
  // P1-3: retailer + settings + owner membership + session created ATOMICALLY by a DB function.
  // Rolls back on any failure (no half-provisioned tenant); idempotent (returns existing store).
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/provision_verified_retailer`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_email: e, p_store_name: storeName || null }),
  });
  if (!r.ok) throw new Error('provision failed: ' + (await r.text()).slice(0, 200));
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.retailer_id) throw new Error('provision returned no row');
  return { retailer_id: row.retailer_id, slug: row.slug, session_id: row.session_id, already: !!row.already };
}

async function sendCode(email, code) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', { method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Demohub <bookings@demohubhq.com>', to: email, subject: 'Your Demohub verification code',
        html: `<p>Your code is <strong style="font-size:20px">${code}</strong>. It expires in 30 minutes.</p>` }) });
  } catch (_) {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

  if (action === 'request') {
    // Always respond the same way (no account enumeration). Only email a code.
    try { const ch = await createChallenge(email, 'retailer_signup', { store_name: String(body.store_name || '').slice(0, 120) }); await sendCode(email, ch.code); } catch (_) {}
    return res.status(200).json({ ok: true, message: 'If that email can receive mail, a code is on its way.' });
  }

  if (action === 'verify') {
    const code = String(body.code || '').trim();
    const r = await consumeChallenge(email, 'retailer_signup', code);
    if (!r.ok) return res.status(400).json({ error: 'verification_failed', reason: r.reason });
    // Don't create a second store if this email already owns one.
    const existing = await rest(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id,slug&limit=1`);
    const exRows = existing.ok ? await existing.json() : [];
    if (exRows.length) return res.status(200).json({ ok: true, already: true, slug: exRows[0].slug });
    const prov = await provisionVerifiedRetailer(email, r.payload && r.payload.store_name);
    setSessionCookie(res, prov.session_id); // land them logged in — no token in URL
    return res.status(200).json({ ok: true, slug: prov.slug, session_id: prov.session_id, admin_url: `${SITE_ORIGIN}/r/${prov.slug}/admin`, public_url: `${SITE_ORIGIN}/r/${prov.slug}` });
  }
  return res.status(400).json({ error: 'unknown action' });
}
