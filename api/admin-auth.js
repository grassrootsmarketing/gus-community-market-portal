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
  const sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
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
    if (action === 'login') {
      const { email, retailer_slug } = body || {};
      if (!email || !retailer_slug) return res.status(400).json({ error: 'email and retailer_slug required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name,billing_email`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;

      // Always respond 200 to prevent enumeration. Only actually send if email matches billing_email.
      if (retailer && retailer.billing_email && retailer.billing_email.toLowerCase() === email.toLowerCase()) {
        const tokens = await sb(`admin_tokens`, {
          method: 'POST',
          body: JSON.stringify({ email: retailer.billing_email, retailer_id: retailer.id }),
        });
        const token = Array.isArray(tokens) ? tokens[0]?.token : null;
        const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
        const link = `${origin}/r/${retailer_slug}/admin?token=${encodeURIComponent(token)}`;
        if (RESEND_API_KEY && token) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: FROM_ADDRESS, to: retailer.billing_email, subject: `Sign in to ${retailer.name} admin`, html: magicLinkEmail({ retailerName: retailer.name, link }) }),
            });
          } catch (_) { /* swallow */ }
        }
      }
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

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
