// /api/booking — Vercel serverless function
// Writes a booking row to Supabase and sends a confirmation email via Resend.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_KEY = 'sb_publishable__e8tiRc5-f7Wexa-r1Perg_hJ84vltF';
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

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
    const { retailer_slug, brand_name, contact_name, contact_email, contact_phone, product, venue, demo_date, demo_time, notes } = body || {};

    if (!contact_email || !brand_name || !venue || !demo_date || !demo_time || !retailer_slug) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Look up retailer by slug, get id, name, and cancellation policy
    const retailerResp = await fetch(`${SUPABASE_URL}/rest/v1/retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name,cancellation_policy`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const retailers = await retailerResp.json();
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'Retailer not found' });
    const RETAILER_ID = retailer.id;
    const RETAILER_NAME = retailer.name;
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
        status: 'pending',
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

    return res.status(200).json({ success: true, booking_id: bookingId, email_sent: emailOk, email_error: emailErr });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
