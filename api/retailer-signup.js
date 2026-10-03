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
import { OWNER_ALERT_EMAIL } from './_owner-alerts.js';
import { signinConfigStatus, signinUnavailableBody, logSigninConfigFailure, logSigninMailFailure } from './_signin-config.js';
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
export async function provisionVerifiedRetailer(email, storeName, opts = {}) {
  const e = String(email).trim().toLowerCase();
  const phone = opts.phone ? String(opts.phone).trim().slice(0, 40) : null;
  const contactName = opts.contactName ? String(opts.contactName).trim().slice(0, 120) : null;
  const storeCount = Number.isFinite(opts.storeCount) ? Math.max(1, Math.min(999, Math.round(opts.storeCount))) : null;
  // P1-3: retailer + settings + owner membership + session created ATOMICALLY by a DB function.
  // Rolls back on any failure (no half-provisioned tenant); idempotent (returns existing store).
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/provision_verified_retailer`, {
    method: 'POST',
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_email: e, p_store_name: storeName || null, p_phone: phone, p_contact_name: contactName, p_store_count: storeCount }),
  });
  if (!r.ok) throw new Error('provision failed: ' + (await r.text()).slice(0, 200));
  const rows = await r.json();
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.retailer_id) throw new Error('provision returned no row');
  return { retailer_id: row.retailer_id, slug: row.slug, session_id: row.session_id, already: !!row.already };
}

async function sendCode(email, code) {
  const sent = await sendMailQuietly({ from: 'Demohub <bookings@demohubhq.com>', to: email, subject: 'Your Demohub verification code',
    html: `<p>Your code is <strong style="font-size:20px">${code}</strong>. It expires in 30 minutes.</p>` }, { binding: _b });
  logSigninMailFailure('retailer-signup', sent);
}

// ---- Spam control (2026-09-30, atomic per Codex RA-1) ----
// Hourly budgets live in signup_budgets (0086) and are taken through signup_budget_take(): one INSERT ... ON
// CONFLICT DO UPDATE whose increment is conditional on count < max, so the database serialises concurrent hits and
// admits at most max per bucket and hour, however many arrive together. Returns true (admitted), false (over the
// cap) or null (budget unavailable: callers fail closed). Addresses are hashed before they become bucket keys; the
// hash is a pseudonymous identifier, not anonymity.
async function budgetTake(key, max) {
  try {
    const ws = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const r = await rest('rpc/signup_budget_take', { method: 'POST', body: JSON.stringify({ p_bucket_key: key, p_window_start: ws, p_max: max }) });
    if (!r.ok) throw new Error('rpc ' + r.status);
    const rows = await r.json(); const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || typeof row.admitted !== 'boolean') throw new Error('unexpected shape');
    return row.admitted;
  } catch (e) { console.error('retailer-signup budget unavailable:', e?.message || e); return null; }
}
// Client address as the hosting platform reports it. Vercel sets x-forwarded-for / x-real-ip / x-vercel-forwarded-for
// to the connecting client's public IP and overwrites any value the caller sent ("we currently overwrite the
// X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing",
// vercel.com/docs/headers/request-headers, read 2026-09-30). x-vercel-forwarded-for is preferred because it survives a
// proxy placed in front of Vercel; the others are identical on a direct deployment. Nothing else (cf-connecting-ip,
// true-client-ip) is trusted: a caller can set those freely.
function clientIp(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const ip = first(req.headers['x-vercel-forwarded-for']) || first(req.headers['x-real-ip']) || first(req.headers['x-forwarded-for']) || req.socket?.remoteAddress || 'unknown';
  return String(ip).slice(0, 64);
}
const emailKey = (e) => crypto.createHash('sha256').update(String(e)).digest('hex').slice(0, 32);
// The store's real review state, so the reply never tells an already-live store it is awaiting approval (Codex RA-2).
async function liveState(retailerId) {
  try { const r = await rest(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=verification_status`); const row = r.ok ? (await r.json())[0] : null; const st = row ? row.verification_status : null;
    return { live: st === 'approved', pending_approval: st === 'pending', review_state: st || 'unknown' }; }
  catch (_) { return { live: false, pending_approval: null, review_state: 'unknown' }; }
}
export const SIGNUP_LIMITS = Object.freeze({ requestsPerIpPerHour: 5, codeEmailsPerAddressPerHour: 3, verifiesPerIpPerHour: 30 });

// ---- Owner notice (2026-09-30): one email to the operator when a NEW store is provisioned. The store is
// created pending (0056 default) and takes no bookings until approved, so this is the prompt to review it.
// Best effort: the durable record is the pending retailer row, which the owner panel lists.
async function notifyOwnerOfSignup(email, pl, prov) {
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = String(pl.store_name || prov.slug).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const rows = [['Store', store], ['Contact', pl.contact_name || 'not given'], ['Email', email], ['Phone', pl.phone || 'not given'],
    ['Stores', pl.store_count || 'not given'], ['Booking page (not live yet)', link(_b, '/r/' + prov.slug)]];
  const html = '<p>A new retailer signed up on Demohub and is <strong>waiting for your approval</strong>. Its booking page takes no bookings until you approve it.</p>'
    + '<table>' + rows.map(([k, v]) => '<tr><td style="padding:2px 14px 2px 0;color:#667;">' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</table>'
    + '<p><a href="' + esc(link(_b, '/owner')) + '">Review it in the owner panel</a>, Retailers tab.</p>';
  await sendMailQuietly({ from: 'Demohub <bookings@demohubhq.com>', to: OWNER_ALERT_EMAIL, subject: 'New retailer sign-up: ' + store + ' (pending approval)', html }, { binding: _b });
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
  // Codex S-1: configuration failure is a 503 for everyone, before budgets and lookups.
  { const cfg = signinConfigStatus(_b); if (!cfg.ok) { logSigninConfigFailure('retailer-signup', cfg); return res.status(503).json(signinUnavailableBody(cfg)); } }

  if (action === 'request') {
    // Spam control: at most SIGNUP_LIMITS.requestsPerIpPerHour code requests per network (429), and at most
    // codeEmailsPerAddressPerHour code emails per address. Over the per-address cap the reply is the same
    // generic 200 with no mail, so the limit reveals nothing about the address. Limiter down: 503.
    const ipOk = await budgetTake('rsu-req-ip:' + clientIp(req), SIGNUP_LIMITS.requestsPerIpPerHour);
    if (ipOk === null) return res.status(503).json({ error: 'rate_limit_unavailable', message: 'Sign-up is briefly unavailable. Try again in a moment.' });
    if (!ipOk) return res.status(429).json({ error: 'too_many_requests', message: 'Too many sign-up attempts from this network. Try again in an hour.' });
    const addrOk = await budgetTake('rsu-req-email:' + emailKey(email), SIGNUP_LIMITS.codeEmailsPerAddressPerHour);
    if (addrOk === null) return res.status(503).json({ error: 'rate_limit_unavailable', message: 'Sign-up is briefly unavailable. Try again in a moment.' });
    if (!addrOk) return res.status(200).json({ ok: true, message: 'If that email can receive mail, a code is on its way.' });
    // Always respond the same way (no account enumeration). Only email a code.
    try {
      const ch = await createChallenge(email, 'retailer_signup', {
        store_name: String(body.store_name || '').slice(0, 120),
        contact_name: String(body.contact_name || '').slice(0, 120),
        phone: String(body.phone || '').slice(0, 40),
        store_count: Number.isFinite(+body.store_count) ? Math.max(1, Math.min(999, Math.round(+body.store_count))) : null,
      });
      await sendCode(email, ch.code);
    } catch (_) {}
    return res.status(200).json({ ok: true, message: 'If that email can receive mail, a code is on its way.' });
  }

  if (action === 'verify') {
    const vOk = await budgetTake('rsu-verify-ip:' + clientIp(req), SIGNUP_LIMITS.verifiesPerIpPerHour);
    if (vOk === null) return res.status(503).json({ error: 'rate_limit_unavailable', message: 'Sign-up is briefly unavailable. Try again in a moment.' });
    if (!vOk) return res.status(429).json({ error: 'too_many_requests', message: 'Too many attempts from this network. Try again in an hour.' });
    const code = String(body.code || '').trim();
    const r = await consumeChallenge(email, 'retailer_signup', code);
    if (!r.ok) return res.status(400).json({ error: 'verification_failed', reason: r.reason });
    // Don't create a second store if this email already owns one.
    const existing = await rest(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id,slug&limit=1`);
    const exRows = existing.ok ? await existing.json() : [];
    if (exRows.length) return res.status(200).json({ ok: true, already: true, slug: exRows[0].slug, ...(await liveState(exRows[0].id)) });
    const pl = r.payload || {};
    const prov = await provisionVerifiedRetailer(email, pl.store_name, {
      phone: pl.phone, contactName: pl.contact_name, storeCount: Number.isFinite(+pl.store_count) ? +pl.store_count : null,
    });
    setSessionCookie(res, prov.session_id); // land them logged in — no token in URL
    if (!prov.already) await notifyOwnerOfSignup(email, pl, prov);
    const state = await liveState(prov.retailer_id); // read, not assumed: an existing store may already be live
    // The session leaves this process ONLY as the Set-Cookie above. It used to be in this body as
    // well, where page script could read it and put it in localStorage — the cookie was HttpOnly
    // and the copy beside it was not, which cancelled the point of the cookie.
    // provisionVerifiedRetailer() still returns session_id: that is a server-side value consumed
    // one line up and never serialised.
    return res.status(200).json({ ok: true, already: !!prov.already, ...state, slug: prov.slug, admin_url: link(_b, `/r/${prov.slug}/admin`), public_url: link(_b, `/r/${prov.slug}`) });
  }
  return res.status(400).json({ error: 'unknown action' });
}
