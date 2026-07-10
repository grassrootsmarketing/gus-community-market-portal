// /api/booking-action — Admin confirms, declines, or cancels a booking.
// On confirm: flips bookings.status to 'confirmed', creates a demos row, emails the brand.
// On decline: flips bookings.status to 'declined', emails the brand.
// On cancel: flips bookings.status to 'cancelled', refunds via Stripe if paid,
//            respecting the retailer's cancellation_mode (refundable | non_refundable).
//            The 14-day cutoff applies for refundable mode: refund only if the demo
//            is more than 14 days out; otherwise refund is at the retailer's discretion.
// Uses service_role; must be called from a Cloudflare-Access-gated admin page.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

// Days-before-demo cutoff for auto-refund under the refundable cancellation mode.
const REFUND_CUTOFF_DAYS = 14;

// Fire a full-amount refund on Stripe for the given payment_intent_id.
async function refundPaymentIntent(paymentIntentId, opts = {}) {
  if (!STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  if (!paymentIntentId) return { ok: false, error: 'payment_intent_id required' };
  const params = new URLSearchParams();
  params.set('payment_intent', paymentIntentId);
  // Refund the platform fee too so the brand is made whole.
  params.set('refund_application_fee', 'true');
  // Reverse the transfer to the connected retailer account.
  params.set('reverse_transfer', 'true');
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) {
      params.set(`metadata[${k}]`, String(v));
    }
  }
  try {
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const json = await r.json();
    if (!r.ok) return { ok: false, error: json?.error?.message || `HTTP ${r.status}`, detail: json };
    return { ok: true, refund_id: json.id, amount: json.amount };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function daysUntilDemo(demo_date) {
  if (!demo_date) return 0;
  const demo = new Date(demo_date + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.floor((demo - now) / (24 * 60 * 60 * 1000));
}

function cancelledEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, reason, refundStatus }) {
  const refundLine = refundStatus === 'issued'
    ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Your full booking fee will show up back on your card in 5&ndash;10 business days.</p>`
    : refundStatus === 'pending_manual'
    ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">${html(retailerName)} will follow up with you about the refund directly, per their cancellation policy.</p>`
    : refundStatus === 'not_paid'
    ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">No charge was captured for this booking, so nothing needs to be refunded.</p>`
    : `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">If your card was charged, ${html(retailerName)} will follow up about the refund per their cancellation policy.</p>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo cancelled</div>
<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Your demo has been cancelled${contact_name ? ', ' + html(contact_name) : ''}.</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">${html(retailerName)} cancelled your demo for <strong>${html(brand_name || 'your brand')}</strong> on ${html(dateLabel)} at ${html(demo_time)} (${html(venueName)}).</p>
${reason ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;"><strong>Note from the store:</strong> ${html(reason)}</p>` : ''}
${refundLine}
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">To pick a different date, head back to <a href="https://www.demohubhq.com/brand/dashboard" style="color:#2a5b32;">your Demohub dashboard</a>.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
</table></body></html>`;
}

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID format guard — prevents Postgres "invalid input syntax for type uuid" errors
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

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
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">You're on${contact_name ? ', ' + html(contact_name) : ''} &#10003;</h1>
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
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
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
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">You're welcome to pick a different date &mdash; just head back to <a href="https://demohubhq.com/r/gus" style="color:#2a5b32;">demohubhq.com/r/gus</a>.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
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
    const { booking_id, action, reason, demo_fee, session_id, force_refund } = body || {};
    if (!booking_id || !['confirm', 'decline', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'booking_id and action=confirm|decline|cancel required' });
    }
    if (!isUuid(booking_id)) return res.status(400).json({ error: 'Invalid booking_id' });

    // === Session check ===
    if (!session_id) return res.status(401).json({ error: 'Invalid or missing admin session' });
    if (!isUuid(session_id)) return res.status(401).json({ error: 'Invalid admin session' });
    let sessRows;
    try {
      sessRows = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    } catch (_) { return res.status(401).json({ error: 'Invalid admin session' }); }
    const session = Array.isArray(sessRows) ? sessRows[0] : null;
    if (!session) return res.status(401).json({ error: 'Invalid admin session' });
    if (new Date(session.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'Session expired' });

    // Fetch booking + retailer + venue
    let bookings;
    try {
      bookings = await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&select=*`);
    } catch (_) { return res.status(404).json({ error: 'Booking not found' }); }
    const booking = Array.isArray(bookings) ? bookings[0] : null;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Confirm and decline require pending. Cancel accepts pending or confirmed.
    if (action === 'cancel') {
      if (!['pending', 'confirmed'].includes(booking.status)) {
        return res.status(409).json({ error: 'Booking already ' + booking.status });
      }
    } else if (booking.status !== 'pending') {
      return res.status(409).json({ error: 'Booking already ' + booking.status });
    }
    if (booking.retailer_id !== session.retailer_id) return res.status(403).json({ error: 'Not allowed for this retailer' });

    // Race check at confirmation
    if (action === 'confirm') {
      const cap = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=max_demos_per_slot`);
      const venueCap = (Array.isArray(cap) && cap[0]) ? Math.max(1, parseInt(cap[0].max_demos_per_slot, 10) || 1) : 1;
      const dupRows = await sb(`demos?retailer_id=eq.${encodeURIComponent(booking.retailer_id)}&venue_id=eq.${encodeURIComponent(booking.venue_id)}&demo_date=eq.${encodeURIComponent(booking.demo_date)}&demo_time=eq.${encodeURIComponent(booking.demo_time)}&status=in.(confirmed,completed)&select=id`);
      const takenCount = Array.isArray(dupRows) ? dupRows.length : 0;
      if (takenCount >= venueCap) {
        return res.status(409).j