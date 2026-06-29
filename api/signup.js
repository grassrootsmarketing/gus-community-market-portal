// /api/signup — Self-serve retailer onboarding.
// Creates a new retailer row, generates a unique slug, seeds default venues,
// settings, and a starter availability schedule. Returns the new admin URL.
// Uses service_role.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';

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


// === Rate limit: max 10 signups per IP per hour (conservative; bumps for trusted IPs later) ===
async function checkRateLimit(req, bucketKey, maxPerHour) {
  try {
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    const key = bucketKey + ':' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existing = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false, current: row.count };
    if (row) {
      await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    } else {
      await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    }
    return { allowed: true, current: (row ? row.count : 0) + 1 };
  } catch (_) { return { allowed: true, current: 0 }; }  // fail-open on rate-limiter errors
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
  // Default shifts: 11:00-14:00 (lunch/early afternoon) and 15:00-18:00 (afternoon/evening).
  // Retailers can adjust per-store in admin after signup.
  const twoShifts = [
    { open: "11:00", close: "14:00", preferred: false },
    { open: "15:00", close: "18:00", preferred: false },
  ];
  return {
    schedule: {
      "0": null,                    // Sunday closed by default
      "1": null,                    // Monday closed
      "2": null,                    // Tuesday closed
      "3": null,                    // Wednesday closed
      "4": null,                    // Thursday closed
      "5": twoShifts,               // Friday: both shifts
      "6": twoShifts,               // Saturday: both shifts
    },
    blackouts: [],
  };
}

// Day-0 welcome (markdown source: outputs/email-templates/retailer-welcome-day-0.md)
function retailerDay0Email({ first_name, admin_url, public_booking_url }) {
  const fn = html(first_name || 'there');
  const au = html(admin_url);
  const pu = html(public_booking_url);
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;font-size:15px;line-height:1.6;color:#3a3a36;">
<p style="margin:0 0 14px;">Hi ${fn},</p>
<p style="margin:0 0 14px;">Welcome to Demohub. Your admin is live and waiting for you here: <strong><a href="${au}" style="color:#2a5b32;">${au}</a></strong></p>
<p style="margin:0 0 14px;">I built this for retailers like you &mdash; independent grocers and specialty shops who'd rather spend Friday on the floor than chasing demo schedules in a spreadsheet. The whole platform is one place to confirm bookings, track COI expirations, and run every store you operate.</p>
<p style="margin:0 0 8px;">Four things to get you set up:</p>
<ol style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:6px;"><strong>Set your hours and demo windows</strong> for each store, so brands can only book inside slots you actually staff. (Settings &rarr; Stores.)</li>
<li style="margin-bottom:6px;"><strong>Add your team contacts</strong> &mdash; the manager, the floor lead, anyone who needs the demo schedule. (Settings &rarr; Team.)</li>
<li style="margin-bottom:6px;"><strong>Sync your calendar</strong> so confirmed demos show up next to everything else on your week. (Settings &rarr; Calendar feed.)</li>
<li style="margin-bottom:6px;"><strong>Share your booking link</strong> with the brands you already work with: <a href="${pu}" style="color:#2a5b32;">${pu}</a></li>
</ol>
<p style="margin:0 0 14px;">If you get stuck or want a walkthrough, just hit reply &mdash; I read every email myself. We'll be in touch in a few days to check in.</p>
<p style="margin:0 0 4px;">Welcome aboard,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; [Mailing address pending — please update via virtual mailbox or PO Box. Required by CAN-SPAM. Contact david@demohubhq.com for current address.]<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nWelcome to Demohub. Your admin is live and waiting for you here: ${admin_url}\n\nI built this for retailers like you — independent grocers and specialty shops who'd rather spend Friday on the floor than chasing demo schedules in a spreadsheet. The whole platform is one place to confirm bookings, track COI expirations, and run every store you operate.\n\nFour things to get you set up:\n\n1. Set your hours and demo windows for each store, so brands can only book inside slots you actually staff. (Settings → Stores.)\n2. Add your team contacts — the manager, the floor lead, anyone who needs the demo schedule. (Settings → Team.)\n3. Sync your calendar so confirmed demos show up next to everything else on your week. (Settings → Calendar feed.)\n4. Share your booking link with the brands you already work with: ${public_booking_url}\n\nIf you get stuck or want a walkthrough, just hit reply — I read every email myself. We'll be in touch in a few days to check in.\n\nWelcome aboard,\nDavid\nDemohub`;
  const subject = `Welcome to Demohub, ${first_name || 'there'} — let's get your store set up`;
  return { subject, html: htmlBody, text };
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

  // Rate limit: 10 signups per IP per hour (signup is unauthenticated, prevents bulk abuse)
  const rl = await checkRateLimit(req, 'signup', 10);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many signups from this IP. Try again in an hour.' });

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
    const venueCount = Math.max(1, Math.min(999, parseInt(store_count, 10) || 1));
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

    // 2.5) Register the signup email as an owner-level admin so they can sign in
    try {
      await sb(`retailer_admins`, {
        method: 'POST',
        body: JSON.stringify({
          retailer_id: retailer.id,
          email: billing_email.toLowerCase().trim(),
          role: 'owner',
        }),
      });
    } catch (e) { console.warn('retailer_admins insert failed:', e); }

    // 2.6) Generate a one-shot magic-link token so the signup success "Open admin"
    //      button can drop the user straight into their admin (logged in) without
    //      forcing them through an email round-trip.
    let signupToken = null;
    try {
      const tokens = await sb(`admin_tokens`, {
        method: 'POST',
        body: JSON.stringify({
          email: billing_email.toLowerCase().trim(),
          retailer_id: retailer.id,
        }),
      });
      signupToken = Array.isArray(tokens) ? (tokens[0]?.token || null) : null;
    } catch (e) { console.warn('signup admin_tokens insert failed:', e?.message || e); }

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

    // 4) Send Day-0 welcome email (best-effort) + stamp welcome_day0_sent_at
    let emailOk = false;
    if (RESEND_API_KEY) {
      try {
        const firstName = (contact_name || '').trim().split(/\s+/)[0] || retailer_name;
        const built = retailerDay0Email({ first_name: firstName, admin_url: adminUrl, public_booking_url: publicUrl });
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: FROM_ADDRESS, to: billing_email, reply_to: REPLY_TO, subject: built.subject, html: built.html, text: built.text }),
        });
        emailOk = r.ok;
        if (emailOk) {
          // Stamp welcome_day0_sent_at. Wrap in try/catch — if the migration hasn't run yet,
          // don't blow up signup. PostgREST will return 400 on unknown column; swallow it.
          try {
            await sb(`retailers?id=eq.${encodeURIComponent(retailer.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ welcome_day0_sent_at: new Date().toISOString() }),
            });
          } catch (e) { console.warn('welcome_day0_sent_at stamp skipped:', e?.message || e); }
        }
      } catch (_) { emailOk = false; }
    }

    const adminUrlWithToken = signupToken
      ? `${adminUrl}?token=${encodeURIComponent(signupToken)}`
      : adminUrl;
    return res.status(200).json({
      ok: true,
      retailer_id: retailer.id,
      slug,
      admin_url: adminUrl,
      admin_url_with_token: adminUrlWithToken,
      session_token: signupToken,
      public_url: publicUrl,
      email_sent: emailOk,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
