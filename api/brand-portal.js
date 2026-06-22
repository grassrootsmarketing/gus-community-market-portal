// /api/brand-portal — Brand-side auth + data fetch.
// Actions:
//   POST { action: "login",  email, retailer_slug }  → emails a magic link
//   POST { action: "verify", token }                  → returns { session_id, email, retailer_id }
//   POST { action: "data",   session_id, retailer_slug } → returns { brand, demos, compliance }
//
// Uses service_role; brand_tokens and brand_sessions tables are RLS-locked so only
// this endpoint touches them.

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

function magicLinkEmail({ contact_name, retailerName, link, expires_at }) {
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
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;color:#0f2c17;margin:0 0 12px;">Your brand portal link</h1>
<p style="font-size:15px;line-height:1.55;color:#3a3a36;margin:0 0 22px;">Hi${contact_name ? ' ' + html(contact_name) : ''}, click below to view your demos at ${html(retailerName)}.</p>
<p style="margin:0 0 22px;"><a href="${html(link)}" style="background:#0f2c17;color:white;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">Open my portal</a></p>
<p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:0;">This link is good for 24 hours. If you didn't ask for it, just ignore this email.</p>
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

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

      // Check this email actually exists on a brand_contact for this retailer (else: still pretend to send to avoid enumeration)
      const contacts = await sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(retailer.id)}&email=eq.${encodeURIComponent(email)}&select=name,company`);
      const contact = Array.isArray(contacts) && contacts[0] ? contacts[0] : null;

      if (contact) {
        const tokens = await sb(`brand_tokens`, {
          method: 'POST',
          body: JSON.stringify({ email, retailer_id: retailer.id }),
        });
        const token = Array.isArray(tokens) ? tokens[0]?.token : null;
        const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
        const link = `${origin}/b/${retailer_slug}/?token=${encodeURIComponent(token)}`;
        if (RESEND_API_KEY && token) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: FROM_ADDRESS, to: email, reply_to: 'david@demohubhq.com', subject: `Your ${retailer.name} brand portal`, html: magicLinkEmail({ contact_name: contact.name, retailerName: retailer.name, link }) }),
            });
          } catch (_) { /* swallow */ }
        }
      }
      // Always respond 200 to prevent email enumeration
      return res.status(200).json({ ok: true });
    }

    // ---- VERIFY: exchange token for session ----
    if (action === 'verify') {
      const { token } = body || {};
      if (!token) return res.status(400).json({ error: 'token required' });
      const tokens = await sb(`brand_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const trow = Array.isArray(tokens) ? tokens[0] : null;
      if (!trow) return res.status(404).json({ error: 'Token not found' });
      if (trow.used_at) return res.status(409).json({ error: 'Token already used' });
      if (new Date(trow.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Token expired' });

      // Mark token used + create session
      await sb(`brand_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessions = await sb(`brand_sessions`, {
        method: 'POST',
        body: JSON.stringify({ email: trow.email, retailer_id: trow.retailer_id }),
      });
      const session = Array.isArray(sessions) ? sessions[0] : null;
      return res.status(200).json({ ok: true, session_id: session?.session_id, email: trow.email, retailer_id: trow.retailer_id });
    }

    // ---- DATA: return demos + COI for this brand ----
    if (action === 'data') {
      const { session_id, retailer_slug } = body || {};
      if (!session_id || !retailer_slug) return res.status(400).json({ error: 'session_id and retailer_slug required' });

      const sessions = await sb(`brand_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
      const session = Array.isArray(sessions) ? sessions[0] : null;
      if (!session) return res.status(401).json({ error: 'Invalid session' });
      if (new Date(session.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Session expired' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;
      if (!retailer || retailer.id !== session.retailer_id) return res.status(403).json({ error: 'Wrong retailer' });

      const contacts = await sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(retailer.id)}&email=eq.${encodeURIComponent(session.email)}&select=*`);
      const contact = Array.isArray(contacts) ? contacts[0] : null;
      if (!contact) return res.status(404).json({ error: 'Brand not found' });

      // Demos: match by company name (since demos.company_name + retailer_id), filter to this brand's demos
      const demos = await sb(`demos?retailer_id=eq.${encodeURIComponent(retailer.id)}&company_name=eq.${encodeURIComponent(contact.company)}&select=*&order=demo_date.desc`);
      // Compliance records for this brand
      const compliance = await sb(`compliance_records?retailer_id=eq.${encodeURIComponent(retailer.id)}&brand_contact_id=eq.${encodeURIComponent(contact.id)}&select=*`);
      // Venues (so we can show names)
      const venues = await sb(`venues?retailer_id=eq.${encodeURIComponent(retailer.id)}&select=id,name`);

      return res.status(200).json({
        ok: true,
        brand: { name: contact.name, company: contact.company, email: contact.email, id: contact.id },
        retailer: { name: retailer.name, slug: retailer_slug },
        demos: demos || [],
        compliance: compliance || [],
        venues: venues || [],
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
