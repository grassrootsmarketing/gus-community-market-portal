// api/retailer-signup.js — F5-03: verified, transactional self-serve retailer signup.
// Flow: request a code (proves email ownership) -> verify the code -> ONLY THEN provision a
// free Solo retailer + owner membership + session. No account/session before email proof.
// Paid tiers (pro/enterprise) are a separate upgrade; signup always creates a free Solo store.

import crypto from 'node:crypto';
import { FLAGS } from './_flags.js';
import { createChallenge, consumeChallenge } from './_verify.js';

import { getBinding, sendBindingFailure } from './_env.js';
import { setSessionCookie as setRoleCookie } from './_cookies.js';
import { requireSameOrigin } from './_csrf.js';
import { sendMailQuietly, link } from './_mail.js';
let _b = null;

function rest(path, opts = {}) {
  return fetch(`${_b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
// Set the same HttpOnly session cookie admin-auth.js issues, so a freshly
// verified owner lands in their admin already logged in (no token in the URL).
// Codex finding B: "the same cookie as admin-auth.js" was a raw string duplicated here, which is
// how a rename becomes a silent sign-in failure. Delegated, so there is one definition of the name
// and its attributes.
function setSessionCookie(res, sessionId) {
  setRoleCookie(res, 'retailer', sessionId);
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
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/provision_verified_retailer`, {
    method: 'POST',
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_email: e, p_store_name: storeName || null }),
  });
  if (!r.ok) throw new Error('provision failed: ' + (await r.text()).slice(0, 200));
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.retailer_id) throw new Error('provision returned no row');
  return { retailer_id: row.retailer_id, slug: row.slug, session_id: row.session_id, already: !!row.already };
}

async function sendCode(email, code) {
  if (!_b.resendApiKey) return;
  await sendMailQuietly({ from: 'Demohub <bookings@demohubhq.com>', to: email, subject: 'Your Demohub verification code',
    html: `<p>Your code is <strong style="font-size:20px">${code}</strong>. It expires in 30 minutes.</p>` }, { binding: _b });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // Closed-launch envelope: public self-service retailer signup is OFF unless explicitly enabled.
  // Fails closed — an unset flag keeps it disabled.
  if (!FLAGS.publicRetailerSignup) {
    return res.status(403).json({ error: 'public_signup_disabled',
      message: 'Demohub is invite-only right now. Email david@demohubhq.com to get your store set up.' });
  }
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B: the verify action provisions a tenant and issues a session cookie, so a
  // cross-origin page must not be able to drive it. No exemption applies: no webhook, no cron.
  if (!requireSameOrigin(req, res, _b)) return;
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
    // The session leaves this process ONLY as the Set-Cookie above. It used to be in this body as
    // well, where page script could read it and put it in localStorage — the cookie was HttpOnly
    // and the copy beside it was not, which cancelled the point of the cookie.
    // provisionVerifiedRetailer() still returns session_id: that is a server-side value consumed
    // one line up and never serialised.
    return res.status(200).json({ ok: true, slug: prov.slug, admin_url: link(_b, `/r/${prov.slug}/admin`), public_url: link(_b, `/r/${prov.slug}`) });
  }
  return res.status(400).json({ error: 'unknown action' });
}
