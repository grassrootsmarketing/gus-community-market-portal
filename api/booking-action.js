// /api/booking-action — Admin confirms or declines a pending booking.
// On confirm: flips bookings.status to 'confirmed', creates a demos row, emails the brand.
// On decline: flips bookings.status to 'declined', emails the brand.
// Uses service_role; must be called from a Cloudflare-Access-gated admin page.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function brandHeader() {
  return `<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>`;
}

function confirmedEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, product }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#2a5b32;margin-bottom:14px;">Demo confirmed</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">You're on${contact_name ? ', ' + html(contact_name) : ''} ✓</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 24px;">${html(retailerName)} has confirmed your demo. Here are the details:</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:24px;">
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:14px 18px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(brand_name)}</td></tr>
${product ? `<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(product)}</td></tr>` : ''}
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Store</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(venueName)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(dateLabel)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(demo_time)}</td></tr>
</table>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Reply to this email if anything changes.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> · demohubhq.com</td></tr>
</table></body></html>`;
}

function declinedEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, reason }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo not available</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Hi${contact_name ? ' ' + html(contact_name) : ''},</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Unfortunately ${html(retailerName)} can't host your demo for <strong>${html(brand_name)}</strong> on ${html(dateLabel)} at ${html(demo_time)} (${html(venueName)}).</p>
${reason ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;"><strong>Note from the store:</strong> ${html(reason)}</p>` : ''}
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">You're welcome to pick a different date — just head back to <a href="https://demohubhq.com/r/gus" style="color:#2a5b32;">demohubhq.com/r/gus</a>.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> · demohubhq.com</td></tr>
</table></body></html>`;
}

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
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
    const { booking_id, action, reason, demo_fee, session_id } = body || {};
    if (!booking_id || !['confirm', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'booking_id and action=confirm|decline required' });
    }

    // === Session check ===
    if (!session_id) return res.status(401).json({ error: 'Invalid or missing admin session' });
    const sessRows = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const session = Array.isArray(sessRows) ? sessRows[0] : null;
    if (!session) return res.status(401).json({ error: 'Invalid admin session' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'Session expired' });

    // Fetch booking + retailer + venue (for the email + the demo row)
    const bookings = await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&select=*`);
    const booking = Array.isArray(bookings) ? bookings[0] : null;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') return res.status(409).json({ error: 'Booking already ' + booking.status });
    if (booking.retailer_id !== session.retailer_id) return res.status(403).json({ error: 'Not allowed for this retailer' });

    // === P1: Race check at confirmation ===
    // Before creating a demo row, re-verify that this venue/date/time slot still has capacity.
    if (action === 'confirm') {
      const cap = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=max_demos_per_slot`);
      const venueCap = (Array.isArray(cap) && cap[0]) ? Math.max(1, parseInt(cap[0].max_demos_per_slot, 10) || 1) : 1;
      const dupRows = await sb(`demos?retailer_id=eq.${encodeURIComponent(booking.retailer_id)}&venue_id=eq.${encodeURIComponent(booking.venue_id)}&demo_date=eq.${encodeURIComponent(booking.demo_date)}&demo_time=eq.${encodeURIComponent(booking.demo_time)}&status=in.(confirmed,completed)&select=id`);
      const takenCount = Array.isArray(dupRows) ? dupRows.length : 0;
      if (takenCount >= venueCap) {
        return res.status(409).json({ error: `Slot is at capacity (${takenCount}/${venueCap}). Cannot confirm — decline this booking and ask the brand to pick another slot.` });
      }
    }

    const venues = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=name,demo_fee`);
    const venue = Array.isArray(venues) ? venues[0] : null;
    const retailers = await sb(`retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name,slug`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;

    const newStatus = action === 'confirm' ? 'confirmed' : 'declined';

    // 1) Update booking row
    await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus, ...(action === 'decline' && reason ? { notes: (booking.notes ? booking.notes + '\n\n' : '') + 'Declined: ' + reason } : {}) }),
    });

    let demoId = null;
    // 2) If confirmed, create the demo row
    if (action === 'confirm') {
      const fee = demo_fee != null ? Number(demo_fee) : (venue?.demo_fee != null ? Number(venue.demo_fee) : 30);
      const created = await sb(`demos`, {
        method: 'POST',
        body: JSON.stringify({
          retailer_id: booking.retailer_id,
          venue_id: booking.venue_id,
          company_name: booking.brand_name || 'Unknown',
          contact_name: booking.contact_name || null,
          product: booking.product || null,
          demo_date: booking.demo_date,
          demo_time: booking.demo_time,
          duration_hours: 3,
          status: 'confirmed',
          demo_fee: fee,
          notes: booking.notes || null,
        }),
      });
      demoId = Array.isArray(created) ? created[0]?.id : null;
    }

    // 3) Send email (best-effort)
    let emailOk = false;
    if (RESEND_API_KEY && booking.contact_email) {
      const dateLabel = booking.demo_date ? new Date(booking.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
      const subject = action === 'confirm'
        ? `Your ${retailer?.name || 'demo'} is confirmed`
        : `Update on your ${retailer?.name || 'demo'} request`;
      const htmlBody = action === 'confirm'
        ? confirmedEmail({ contact_name: booking.contact_name, brand_name: booking.brand_name, retailerName: retailer?.name || '', venueName: venue?.name || '', dateLabel, demo_time: booking.demo_time, product: booking.product })
        : declinedEmail({ contact_name: booking.contact_name, brand_name: booking.brand_name, retailerName: retailer?.name || '', venueName: venue?.name || '', dateLabel, demo_time: booking.demo_time, reason });
      try {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_ADDRESS, to: booking.contact_email, subject, html: htmlBody }),
        });
        emailOk = r.ok;
      } catch (_) { emailOk = false; }
    }

    return res.status(200).json({ ok: true, action, booking_id, demo_id: demoId, email_sent: emailOk });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
