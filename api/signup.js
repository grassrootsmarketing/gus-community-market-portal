// /api/signup — Self-serve retailer onboarding.
// Creates a new retailer row, generates a unique slug, seeds default venues,
// settings, and a starter availability schedule. Returns the new admin URL.
// Uses service_role.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <hello@demohubhq.com>';

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'retailer';
}

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

async function uniqueSlug(base) {
  let slug = slugify(base);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? slug : `${slug}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const existing = await sb(`retailers?slug=eq.${encodeURIComponent(candidate)}&select=id`);
    if (!Array.isArray(existing) || existing.length === 0) return candidate;
  }
  throw new Error('Could not generate a unique slug');
}

function defaultAvailability() {
  return {
    schedule: {
      "0": { open: "10:00", close: "18:00" }, // Sun
      "1": null, "2": null, "3": null, "4": null,
      "5": { open: "10:00", close: "18:00" }, // Fri
      "6": { open: "10:00", close: "18:00" }, // Sat
    },
    blackouts: [],
  };
}

function welcomeEmail({ retailerName, slug, adminUrl, publicUrl }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#2a5b32;margin-bottom:14px;">Welcome to Demohub</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">${html(retailerName)} is live</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 24px;">Your booking portal and admin hub are ready. Bookmark these:</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:24px;">
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Public booking</td><td style="padding:14px 18px;text-align:right;font-size:14px;color:#0f2c17;"><a href="${html(publicUrl)}" style="color:#2a5b32;">${html(publicUrl)}</a></td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Admin hub</td><td style="padding:14px 18px;text-align:right;font-size:14px;color:#0f2c17;border-top:1px solid #ede3d0;"><a href="${html(adminUrl)}" style="color:#2a5b32;">${html(adminUrl)}</a></td></tr>
</table>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0 0 6px;">Next steps:</p>
<ul style="font-size:14px;line-height:1.5;color:#3a3a36;margin:0 0 16px;padding-left:20px;">
<li>Add your stores in the admin → Store Availability card</li>
<li>Set your demo fee in Settings</li>
<li>Share your public booking link with brands</li>
</ul>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Reply to this email if you need a hand getting set up.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> · demohubhq.com</td></tr>
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
    const { retailer_name, billing_email, contact_name, store_count, demo_fee } = body || {};

    if (!retailer_name || !billing_email) {
      return res.status(400).json({ error: 'retailer_name and billing_email are required' });
    }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(billing_email)) {
      return res.status(400).json({ error: 'Invalid billing_email' });
    }

    const slug = await uniqueSlug(retailer_name);
    const fee = Math.max(1, Number(demo_fee) || 30);

    // 1) Create retailer
    const retailers = await sb(`retailers`, {
      method: 'POST',
      body: JSON.stringify({
        slug,
        name: retailer_name,
        billing_email,
        branding: { contact_name: contact_name || '' },
      }),
    });
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) throw new Error('Retailer creation returned no rows');

    // 2) Seed a default venue
    const venueCount = Math.max(1, Math.min(20, parseInt(store_count, 10) || 1));
    const venuesPayload = [];
    for (let i = 1; i <= venueCount; i++) {
      venuesPayload.push({
        retailer_id: retailer.id,
        name: venueCount === 1 ? 'Main Store' : `Store ${i}`,
        demo_fee: fee,
        availability: defaultAvailability(),
        max_demos_per_slot: 1,
        active: true,
        display_order: i,
      });
    }
    await sb(`venues`, { method: 'POST', body: JSON.stringify(venuesPayload) });

    // 3) Seed settings row
    try {
      await sb(`settings`, {
        method: 'POST',
        body: JSON.stringify({
          retailer_id: retailer.id,
          demo_fee: fee,
          demo_duration: '3 hours',
          advance_booking_days: 14,
        }),
      });
    } catch (_) { /* settings table may differ; non-fatal */ }

    const base = 'https://demohubhq.com';
    const adminUrl = `${base}/r/${slug}/admin`;
    const publicUrl = `${base}/r/${slug}`;

    // 4) Send welcome email (best-effort)
    let emailOk = false;
    if (RESEND_API_KEY) {
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_ADDRESS, to: billing_email, subject: `${retailer_name} is live on Demohub`, html: welcomeEmail({ retailerName: retailer_name, slug, adminUrl, publicUrl }) }),
        });
        emailOk = r.ok;
      } catch (_) { emailOk = false; }
    }

    return res.status(200).json({ ok: true, retailer_id: retailer.id, slug, admin_url: adminUrl, public_url: publicUrl, email_sent: emailOk });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
