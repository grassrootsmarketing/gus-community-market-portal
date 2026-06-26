// /api/admin-auth — Retailer admin authentication.
//   POST { action: "login",  email, retailer_slug }      → emails magic link if email matches billing_email
//   POST { action: "verify", token }                      → returns session_id
//   POST { action: "data",   session_id, retailer_slug }  → returns { ok, email, retailer_id }
//   POST { action: "logout", session_id }                 → invalidates the session
// Uses service_role; never exposes whether an email is registered (anti-enumeration).

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID format guard — protects against Postgres "invalid input syntax for type uuid" errors
// when callers pass garbage values like "fake" in session_id or other UUID params.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// Reusable helper: verify a session_id is valid for a given retailer_id.
// Exported so /api/admin and /api/booking-action can re-use it.
export async function verifyAdminSession(session_id, expectedRetailerId) {
  if (!session_id) return { ok: false, error: 'No session' };
  if (!isUuid(session_id)) return { ok: false, error: 'Invalid session' };
  let sessions;
  try {
    sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
  } catch (_) {
    return { ok: false, error: 'Invalid session' };
  }
  const session = Array.isArray(sessions) ? sessions[0] : null;
  if (!session) return { ok: false, error: 'Invalid session' };
  if (new Date(session.expires_at).getTime() < Date.now()) return { ok: false, error: 'Session expired' };
  if (expectedRetailerId && session.retailer_id !== expectedRetailerId) return { ok: false, error: 'Wrong retailer' };
  return { ok: true, email: session.email, retailer_id: session.retailer_id };
}

function magicLinkEmail({ retailerName, link }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="36" height="36" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Admin sign in</div>
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;color:#0f2c17;margin:0 0 12px;">Open your ${html(retailerName)} admin</h1>
<p style="font-size:15px;line-height:1.55;color:#3a3a36;margin:0 0 22px;">Click below to access your Demohub admin hub. Link expires in 24 hours.</p>
<p style="margin:0 0 22px;"><a href="${html(link)}" style="background:#0f2c17;color:white;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">Sign in &rarr;</a></p>
<p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:0;">If you didn't request this, ignore the email — no action will be taken.</p>
</td></tr>
</table></body></html>`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const action = body?.action;

    // ---- LOGIN: request a magic link ----
    // Multi-admin: matches against retailer_admins table (multiple users per retailer).
    if (action === 'login') {
      const { email, retailer_slug } = body || {};
      if (!email || !retailer_slug) return res.status(400).json({ error: 'email and retailer_slug required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;

      // Always respond 200 to prevent enumeration. Only actually send if email is in retailer_admins.
      if (retailer) {
        const normalizedEmail = email.toLowerCase().trim();
        const admins = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailer.id)}&email=ilike.${encodeURIComponent(normalizedEmail)}&select=email,role`);
        const adminRow = Array.isArray(admins) ? admins[0] : null;
        if (adminRow) {
          const tokens = await sb(`admin_tokens`, {
            method: 'POST',
            body: JSON.stringify({ email: adminRow.email, retailer_id: retailer.id }),
          });
          const token = Array.isArray(tokens) ? tokens[0]?.token : null;
          const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
          const link = `${origin}/r/${retailer_slug}/admin?token=${encodeURIComponent(token)}`;
          if (RESEND_API_KEY && token) {
            try {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: FROM_ADDRESS, to: adminRow.email, reply_to: 'david@demohubhq.com', subject: `Sign in to ${retailer.name} admin`, html: magicLinkEmail({ retailerName: retailer.name, link }) }),
              });
            } catch (_) { /* swallow */ }
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ---- EMAIL-LOGIN: send magic link(s) by email only — auto-routes to right retailer(s) ----
    if (action === 'email-login') {
      const { email } = body || {};
      if (!email) return res.status(400).json({ error: 'email required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

      const normalizedEmail = email.toLowerCase().trim();

      // Always respond 200 to prevent enumeration. Send 1 link per retailer this email admins.
      try {
        const admins = await sb(`retailer_admins?email=ilike.${encodeURIComponent(normalizedEmail)}&select=retailer_id,role,retailers(id,name,slug)`);
        if (Array.isArray(admins) && admins.length > 0) {
          for (const adminRow of admins) {
            const retailer = adminRow.retailers;
            if (!retailer) continue;
            const tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: normalizedEmail, retailer_id: retailer.id }),
            });
            const token = Array.isArray(tokens) ? tokens[0]?.token : null;
            if (!token) continue;
            const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
            const link = `${origin}/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`;
            if (RESEND_API_KEY) {
              try {
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ from: FROM_ADDRESS, to: normalizedEmail, reply_to: 'david@demohubhq.com', subject: `Sign in to ${retailer.name} admin`, html: magicLinkEmail({ retailerName: retailer.name, link }) }),
                });
              } catch (_) { /* swallow */ }
            }
          }
        }
      } catch (_) { /* swallow to prevent enumeration */ }

      return res.status(200).json({ ok: true });
    }

    // ---- VERIFY: exchange token for session ----
    if (action === 'verify') {
      const { token } = body || {};
      if (!token) return res.status(400).json({ error: 'token required' });
      const tokens = await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const trow = Array.isArray(tokens) ? tokens[0] : null;
      if (!trow) return res.status(404).json({ error: 'Token not found' });
      if (trow.used_at) return res.status(409).json({ error: 'Token already used' });
      if (new Date(trow.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Token expired' });

      await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessions = await sb(`admin_sessions`, {
        method: 'POST',
        body: JSON.stringify({ email: trow.email, retailer_id: trow.retailer_id }),
      });
      const session = Array.isArray(sessions) ? sessions[0] : null;
      return res.status(200).json({ ok: true, session_id: session?.session_id, email: trow.email, retailer_id: trow.retailer_id });
    }

    // ---- DATA: verify session is still valid + return retailer info ----
    if (action === 'data') {
      const { session_id, retailer_slug } = body || {};
      if (!session_id || !retailer_slug) return res.status(400).json({ error: 'session_id and retailer_slug required' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

      const v = await verifyAdminSession(session_id, retailer.id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      return res.status(200).json({ ok: true, email: v.email, retailer_id: v.retailer_id, retailer_name: retailer.name });
    }

    // ---- LOGOUT ----
    if (action === 'logout') {
      const { session_id } = body || {};
      if (session_id) {
        try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}`, { method: 'DELETE' }); } catch(_) {}
      }
      return res.status(200).json({ ok: true });
    }

    // ---- TEAM-LIST: list all admins for the current retailer (session-gated) ----
    if (action === 'team-list') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const admins = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=*&order=created_at`);
      return res.status(200).json({ ok: true, admins, your_email: v.email });
    }

    // ---- TEAM-INVITE: add a new admin (owner/admin only) ----
    if (action === 'team-invite') {
      const { session_id, email, name, role } = body || {};
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
      if (!['admin', 'viewer'].includes(role || 'admin')) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      // Only owners/admins can invite (not viewers)
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot invite team members' });

      const normalizedEmail = email.toLowerCase().trim();
      // Check dup
      const existing = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(normalizedEmail)}&select=id`);
      if (Array.isArray(existing) && existing.length > 0) return res.status(409).json({ error: 'That email is already on the team' });

      const created = await sb(`retailer_admins`, {
        method: 'POST',
        body: JSON.stringify({ retailer_id: v.retailer_id, email: normalizedEmail, name: name || null, role: role || 'admin', invited_by_email: v.email }),
      });
      // Send invitation email with magic link
      try {
        const retailers = await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}&select=name,slug`);
        const retailer = Array.isArray(retailers) ? retailers[0] : null;
        if (retailer && RESEND_API_KEY) {
          const tokens = await sb(`admin_tokens`, {
            method: 'POST',
            body: JSON.stringify({ email: normalizedEmail, retailer_id: v.retailer_id }),
          });
          const token = Array.isArray(tokens) ? tokens[0]?.token : null;
          const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
          const link = `${origin}/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_ADDRESS,
              to: normalizedEmail,
              reply_to: 'david@demohubhq.com',
              subject: `You've been invited to ${retailer.name}'s Demohub admin`,
              html: magicLinkEmail({ retailerName: retailer.name, link }),
            }),
          });
        }
      } catch (e) { console.warn('Invitation email failed:', e); }
      return res.status(200).json({ ok: true, admin: Array.isArray(created) ? created[0] : null });
    }

    // ---- TEAM-REMOVE: remove an admin (owner only; cannot remove owner) ----
    if (action === 'team-remove') {
      const { session_id, admin_id } = body || {};
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return res.status(403).json({ error: 'Only owners can remove team members' });

      const target = await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}&select=*`);
      const targetRow = Array.isArray(target) ? target[0] : null;
      if (!targetRow) return res.status(404).json({ error: 'Member not found' });
      if (targetRow.retailer_id !== v.retailer_id) return res.status(403).json({ error: 'Wrong retailer' });
      if (targetRow.role === 'owner') return res.status(400).json({ error: 'Cannot remove the owner' });

      await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}`, { method: 'DELETE' });
      // Also revoke any active sessions for this email
      try { await sb(`admin_sessions?email=eq.${encodeURIComponent(targetRow.email)}&retailer_id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'DELETE' }); } catch (_) {}
      return res.status(200).json({ ok: true });
    }

    // ---- TEAM-UPDATE-ROLE: change a member's role (owner only) ----
    if (action === 'team-update-role') {
      const { session_id, admin_id, role } = body || {};
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return res.status(403).json({ error: 'Only owners can change roles' });

      const target = await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}&select=*`);
      const targetRow = Array.isArray(target) ? target[0] : null;
      if (!targetRow || targetRow.retailer_id !== v.retailer_id) return res.status(404).json({ error: 'Member not found' });
      if (targetRow.role === 'owner') return res.status(400).json({ error: 'Cannot change owner role' });
      await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      return res.status(200).json({ ok: true });
    }

    // ---- UPLOAD-RETAILER-AVATAR: retailer admin uploads/replaces their store logo ----
    if (action === 'upload-retailer-avatar') {
      const { session_id, image } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const m = String(image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
      const mime = m[1];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — max 2MB' });
      const path = `retailers/${v.retailer_id}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        return res.status(500).json({ error: 'Upload failed: ' + t });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: publicUrl }) });
      return res.status(200).json({ ok: true, logo_url: publicUrl });
    }

    // ---- REMOVE-RETAILER-AVATAR ----
    if (action === 'remove-retailer-avatar') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: null }) });
      return res.status(200).json({ ok: true });
    }

    // ============================================================
    // OWNER PANEL — restricted to allowlist (david@demohubhq.com)
    // ============================================================
    if (action === 'owner-login' || action === 'owner-verify' || action === 'owner-data' || action === 'owner-logout') {
      return await handleOwnerAction(action, req, res, body);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// ============================================================
// OWNER PANEL helpers (gated to OWNER_EMAILS allowlist)
// Reuses admin_sessions + admin_tokens tables. Owner sessions have retailer_id = NULL.
// ============================================================
const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];
const TIER_PRICES = { free: 0, starter: 79, growth: 199, enterprise: 499 };

function randomToken(n = 32) {
  const buf = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
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

function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function verifyOwnerSession(sessionId) {
  if (!sessionId || !isUuid(sessionId)) return null;
  let sessions;
  try {
    sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=email,retailer_id,expires_at`);
  } catch (_) { return null; }
  const s = Array.isArray(sessions) ? sessions[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  if (!OWNER_EMAILS.includes((s.email || '').toLowerCase())) return null;
  return { email: s.email };
}

async function computeOwnerMetrics() {
  const [retailers, brands, demos, bookings, settings] = await Promise.all([
    sb(`retailers?select=id,name,slug,created_at,logo_url,billing_email,billing_tier`),
    sb(`brands?select=id,company_name,created_at,default_coi_url,is_verified`),
    sb(`demos?select=id,retailer_id,brand_id,demo_date,demo_fee,status,created_at`),
    sb(`bookings?select=id,retailer_id,brand_id,status,created_at`),
    sb(`settings?select=retailer_id,billing_tier,price_per_demo`),
  ]);
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = monthKey(lastMonthDate);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  const totalRetailers = retailers.length;
  const totalBrands = brands.length;
  const activeRetailerIds = new Set();
  demos.forEach(d => { if (d.created_at && new Date(d.created_at) >= thirtyDaysAgo) activeRetailerIds.add(d.retailer_id); });
  bookings.forEach(b => { if (b.created_at && new Date(b.created_at) >= thirtyDaysAgo) activeRetailerIds.add(b.retailer_id); });
  const activeRetailers30d = activeRetailerIds.size;

  const demosThisMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === thisMonth).length;
  const demosLastMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === lastMonth).length;
  const demosDeltaPct = demosLastMonth === 0 ? (demosThisMonth > 0 ? 100 : 0) : Math.round(((demosThisMonth - demosLastMonth) / demosLastMonth) * 100);

  const settingsByRetailer = {}; settings.forEach(s => { settingsByRetailer[s.retailer_id] = s; });
  const tierCounts = { free: 0, starter: 0, growth: 0, enterprise: 0 };
  let mrrSubs = 0;
  retailers.forEach(r => {
    const tier = ((settingsByRetailer[r.id]?.billing_tier) || r.billing_tier || 'free').toLowerCase();
    if (tier in tierCounts) tierCounts[tier]++;
    mrrSubs += TIER_PRICES[tier] || 0;
  });
  const perDemoRev = demos
    .filter(d => (d.demo_date || '').slice(0, 7) === thisMonth && (d.status === 'confirmed' || d.status === 'completed'))
    .reduce((s, d) => s + ((parseFloat(d.demo_fee) || 0) / 10), 0);
  const mrrProjection = Math.round(mrrSubs + perDemoRev);

  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short' }) });
  }
  const retailerSignups = months.map(m => ({ month: m.key, label: m.label, count: retailers.filter(r => (r.created_at || '').slice(0, 7) === m.key).length }));
  const brandSignups = months.map(m => ({ month: m.key, label: m.label, count: brands.filter(b => (b.created_at || '').slice(0, 7) === m.key).length }));
  const demosPerMonth = months.map(m => ({ month: m.key, label: m.label, count: demos.filter(d => (d.demo_date || '').slice(0, 7) === m.key).length }));

  const retailerDemoCount = {};
  demos.forEach(d => { if ((d.demo_date || '').slice(0, 7) === thisMonth) retailerDemoCount[d.retailer_id] = (retailerDemoCount[d.retailer_id] || 0) + 1; });
  const retailerMap = Object.fromEntries(retailers.map(r => [r.id, r]));
  const topRetailers = Object.entries(retailerDemoCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([rid, count]) => ({ id: rid, name: retailerMap[rid]?.name || 'Unknown', slug: retailerMap[rid]?.slug || '', demos_this_month: count }));

  const brandActivity = {};
  demos.forEach(d => { if (d.brand_id && d.created_at && new Date(d.created_at) >= thirtyDaysAgo) brandActivity[d.brand_id] = (brandActivity[d.brand_id] || 0) + 1; });
  const brandMap = Object.fromEntries(brands.map(b => [b.id, b]));
  const topBrands = Object.entries(brandActivity).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([bid, count]) => ({ id: bid, name: brandMap[bid]?.company_name || 'Unknown', activity_30d: count }));

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

  const brandsWithoutCoi = brands.filter(b => !b.default_coi_url).slice(0, 25).map(b => ({ id: b.id, name: b.company_name, created_at: b.created_at }));
  const dormantRetailers = retailers.filter(r => !activeRetailerIds.has(r.id)).slice(0, 25).map(r => ({ id: r.id, name: r.name, slug: r.slug, last_active: null }));
  const brandLastDemo = {};
  demos.forEach(d => { if (d.brand_id) { const c = d.created_at; if (!brandLastDemo[d.brand_id] || c > brandLastDemo[d.brand_id]) brandLastDemo[d.brand_id] = c; } });
  const inactiveBrands = brands.filter(b => !brandLastDemo[b.id] || new Date(brandLastDemo[b.id]) < sixtyDaysAgo).slice(0, 25)
    .map(b => ({ id: b.id, name: b.company_name, last_active: brandLastDemo[b.id] || null }));

  return {
    generated_at: new Date().toISOString(),
    headline: { total_retailers: totalRetailers, active_retailers_30d: activeRetailers30d, total_brands: totalBrands, demos_this_month: demosThisMonth, demos_last_month: demosLastMonth, demos_delta_pct: demosDeltaPct, mrr_projection: mrrProjection, mrr_subs: Math.round(mrrSubs), mrr_per_demo: Math.round(perDemoRev), tier_counts: tierCounts },
    trends: { retailer_signups: retailerSignups, brand_signups: brandSignups, demos_per_month: demosPerMonth },
    tables: { top_retailers: topRetailers, top_brands: topBrands, pending_stuck: pendingStuck },
    watchlist: { brands_without_coi: brandsWithoutCoi, dormant_retailers: dormantRetailers, inactive_brands_60d: inactiveBrands },
  };
}

async function handleOwnerAction(action, req, res, body) {
  if (action === 'owner-login') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    const debug = body.debug === true && OWNER_EMAILS.includes(email);
    const diag = { allowlisted: false, insert_ok: false, insert_error: null, insert_response: null, token_found: false, resend_ok: false, resend_error: null, resend_response: null };
    if (OWNER_EMAILS.includes(email)) {
      diag.allowlisted = true;
      // Try multiple INSERT shapes so we can find which one works against current schema
      let token = null;
      const tries = [
        { email, retailer_id: null },
        { email },
        { email, expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
      ];
      for (const body0 of tries) {
        try {
          const tokens = await sb('admin_tokens', { method: 'POST', body: JSON.stringify(body0) });
          diag.insert_ok = true;
          diag.insert_response = Array.isArray(tokens) ? tokens[0] : tokens;
          token = Array.isArray(tokens) ? tokens[0]?.token : null;
          if (token) break;
        } catch (e) {
          diag.insert_error = (diag.insert_error || '') + '; ' + (e?.message || String(e));
        }
      }
      diag.token_found = !!token;
      if (token) {
        const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
        const link = `${origin}/owner?token=${encodeURIComponent(token)}`;
        if (RESEND_API_KEY) {
          try {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: FROM_ADDRESS, to: email, reply_to: 'david@demohubhq.com', subject: 'Sign in to the Demohub owner panel', html: ownerMagicLinkEmail(link) }),
            });
            const j = await r.json().catch(() => null);
            diag.resend_ok = r.ok;
            diag.resend_response = j;
            if (!r.ok) diag.resend_error = `HTTP ${r.status}: ${JSON.stringify(j)}`;
          } catch (e) { diag.resend_error = e?.message || String(e); }
        } else {
          diag.resend_error = 'RESEND_API_KEY not set';
        }
        if (debug) return res.status(200).json({ ok: true, link, diag });
      } else if (debug) {
        return res.status(200).json({ ok: true, diag });
      }
    }
    return res.status(200).json({ ok: true });
  }

  if (action === 'owner-verify') {
    const token = String(body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const tokens = await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
    const tok = Array.isArray(tokens) ? tokens[0] : null;
    if (!tok) return res.status(404).json({ error: 'Token not found' });
    if (tok.used_at) return res.status(409).json({ error: 'Token already used' });
    if (new Date(tok.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Token expired' });
    if (!OWNER_EMAILS.includes((tok.email || '').toLowerCase())) return res.status(403).json({ error: 'Not authorised' });
    await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
    const sessions = await sb('admin_sessions', { method: 'POST', body: JSON.stringify({ email: tok.email, retailer_id: null }) });
    const session = Array.isArray(sessions) ? sessions[0] : null;
    return res.status(200).json({ ok: true, session_id: session?.session_id, email: tok.email });
  }

  if (action === 'owner-data') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
    const v = await verifyOwnerSession(sessionId);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    const metrics = await computeOwnerMetrics();
    return res.status(200).json({ ok: true, ...metrics });
  }

  if (action === 'owner-logout') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
    if (sessionId) {
      try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown owner action' });
}
