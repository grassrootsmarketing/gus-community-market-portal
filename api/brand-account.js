// /api/brand-account
// Magic-link auth + profile CRUD for cross-retailer brand accounts.
// Actions: signup, login, verify, data, profile-update, demos, logout, cron
// Privacy: NEVER expose brand_id to retailer-side endpoints. All retailer
// admin queries continue to filter by retailer_id only.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FROM_EMAIL = 'Demohub <noreply@demohubhq.com>';
const FROM_BOOKINGS = 'Demohub <bookings@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';

function jsonResp(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function randomToken(n = 32) {
  const buf = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
}
async function sendMagicLink(email, link, isNew) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY missing — printing link to logs'); console.log('MAGIC LINK:', link); return; }
  const subject = isNew ? 'Welcome to Demohub — verify your brand account' : 'Sign in to your Demohub brand account';
  const body = `
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c1c1a;">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 12px;">${isNew ? 'Welcome to Demohub.' : 'Sign in to your brand account.'}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;color:#3a3a36;">${isNew ? 'One profile that follows you to every Demohub retailer.' : 'Click below to access your dashboard.'} Link expires in 30 minutes.</p>
      <a href="${link}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 28px;border-radius:99px;text-decoration:none;font-weight:600;font-size:15px;">${isNew ? 'Verify and continue' : 'Sign in'}</a>
      <p style="font-size:13px;color:#6b6a64;margin-top:32px;">If you didn't request this, you can safely ignore the email.</p>
    </div>
  `;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: email, subject, html: body, reply_to: REPLY_TO }),
  });
}
async function verifySession(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,email,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s.brand_id;
}
async function verifySessionFull(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,email,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return { brand_id: s.brand_id, email: s.email };
}

// ===== Welcome series email templates =====

function brandDay0Email({ first_name, brand_name, example_retailer_url }) {
  const fn = escapeText(first_name || 'there');
  const bn = escapeText(brand_name || 'your brand');
  const ex = escapeText(example_retailer_url || 'https://demohubhq.com/r/gus');
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
<p style="margin:0 0 14px;">You're in. Your ${bn} brand profile is live: <strong><a href="https://demohubhq.com/brand/dashboard" style="color:#2a5b32;">https://demohubhq.com/brand/dashboard</a></strong></p>
<p style="margin:0 0 14px;">Here's the idea: you fill out your info once, and that profile follows you to every Demohub retailer. No more re-typing your COI details into the third clipboard at the third store this month.</p>
<p style="margin:0 0 8px;">Two things to do now so your next booking pre-fills cleanly:</p>
<ol style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:6px;"><strong>Upload your Certificate of Insurance.</strong> It attaches automatically to every demo you book at every Demohub retailer. (Profile &rarr; Compliance &rarr; upload.)</li>
<li style="margin-bottom:6px;"><strong>Fill in the rest of your profile</strong> &mdash; phone, website, product categories, and what you typically demo. (Profile &rarr; Contact + Product.)</li>
</ol>
<p style="margin:0 0 14px;">Once that's done, when you visit a Demohub retailer's booking page &mdash; like <a href="${ex}" style="color:#2a5b32;">${ex}</a> &mdash; your info pre-fills. Hit submit and you're done.</p>
<p style="margin:0 0 14px;">If you have a Demohub retailer you already work with, send them your way and they can confirm your next demo in two clicks.</p>
<p style="margin:0 0 14px;">Free forever for brands. Always.</p>
<p style="margin:0 0 4px;">Welcome,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; [Mailing address pending — please update via virtual mailbox or PO Box. Required by CAN-SPAM. Contact david@demohubhq.com for current address.]<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nYou're in. Your ${brand_name || 'your brand'} brand profile is live: https://demohubhq.com/brand/dashboard\n\nHere's the idea: you fill out your info once, and that profile follows you to every Demohub retailer.\n\nTwo things to do now:\n1. Upload your COI (Profile -> Compliance).\n2. Fill in the rest of your profile (Profile -> Contact + Product).\n\nFree forever for brands. Always.\n\nWelcome,\nDavid\nDemohub`;
  const subject = `Welcome to Demohub, ${first_name || 'there'} — one profile for every retailer`;
  return { subject, html: htmlBody, text };
}

function retailerDay3Email({ first_name }) {
  const fn = escapeText(first_name || 'there');
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
<p style="margin:0 0 14px;">It's been a few days since you joined Demohub. Wanted to check in.</p>
<p style="margin:0 0 8px;">A couple of things I see most retailers ask in the first week:</p>
<ul style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:8px;"><strong>"How do I price demos?"</strong> Most start at $30 per slot. You'll see it round to $3 per demo on your Demohub bill &mdash; and you can change it any time, per store.</li>
<li style="margin-bottom:8px;"><strong>"Can I share my booking link on Instagram?"</strong> Yep. Drop the link in your bio or a story &mdash; brands can submit a request without ever calling you.</li>
<li style="margin-bottom:8px;"><strong>"How does the calendar sync work?"</strong> Copy the iCal URL from Settings &rarr; Calendar feed and paste it into Google Calendar, Apple Calendar, or Outlook.</li>
</ul>
<p style="margin:0 0 14px;">If you want a 20-minute walkthrough where I show you how to set up venues, manage team access, and review your first booking, grab a slot here: <a href="https://calendly.com/demohubhq/walkthrough" style="color:#2a5b32;">calendly.com/demohubhq/walkthrough</a></p>
<p style="margin:0 0 14px;">Or just hit reply &mdash; happy to help by email too.</p>
<p style="margin:0 0 4px;">Talk soon,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; [Mailing address pending — please update via virtual mailbox or PO Box. Required by CAN-SPAM. Contact david@demohubhq.com for current address.]<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nIt's been a few days since you joined Demohub. Wanted to check in.\n\n- How to price demos: Most start at $30 per slot.\n- Sharing your booking link: drop it in your Instagram bio.\n- Calendar sync: copy the iCal URL from Settings -> Calendar feed.\n\n20-min walkthrough: https://calendly.com/demohubhq/walkthrough\n\nTalk soon,\nDavid\nDemohub`;
  const subject = `${first_name || 'there'} — how's your Demohub setup going?`;
  return { subject, html: htmlBody, text };
}

function brandFirstDemoEmail({ first_name, retailer_name, demo_date }) {
  const fn = escapeText(first_name || 'there');
  const rn = escapeText(retailer_name || 'your retailer');
  const dd = escapeText(demo_date || '');
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
<p style="margin:0 0 14px;">Your first Demohub demo is confirmed &mdash; <strong>${rn}</strong> on <strong>${dd}</strong>. Congrats. That's one slot you didn't have to chase down by email.</p>
<p style="margin:0 0 8px;">A few quick wins now that you're live:</p>
<ul style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:8px;"><strong>Round out your product categories</strong> so retailers searching for what you make can find you.</li>
<li style="margin-bottom:8px;"><strong>Check your COI expiration date</strong> is current &mdash; if it's within 90 days, retailers will flag the booking.</li>
<li style="margin-bottom:8px;"><strong>Sync your demos to your own calendar.</strong> Profile &rarr; Account &rarr; calendar URL.</li>
</ul>
<p style="margin:0 0 14px;">Want to see every Demohub retailer in one place? It's right at the top of your dashboard. Book a second demo while you're there.</p>
<p style="margin:0 0 14px;">Reply to this email with how the demo went &mdash; we love hearing how things land at the floor.</p>
<p style="margin:0 0 4px;">Cheers,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; [Mailing address pending — please update via virtual mailbox or PO Box. Required by CAN-SPAM. Contact david@demohubhq.com for current address.]<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nYour first Demohub demo is confirmed — ${retailer_name || 'your retailer'} on ${demo_date || ''}. Congrats.\n\n- Round out your product categories.\n- Check your COI expiration date.\n- Sync your demos to your calendar.\n\nCheers,\nDavid\nDemohub`;
  const subject = `Nice — your first demo at ${retailer_name || 'your retailer'} is locked in`;
  return { subject, html: htmlBody, text };
}

// Process an array in concurrent batches. Each batch runs in parallel,
// batches run sequentially. Keeps us under Resend's 2/sec rate limit while
// fitting inside Vercel Hobby's 10s function timeout.
async function processBatched(items, batchSize, processOne) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(processOne));
  }
}

function coiWarningEmail({ tier, first_name, brand_name, expires_label, days_left }) {
  const subjectMap = {
    30: `Your COI expires in 30 days — let's get ahead of it`,
    14: `Reminder: your Demohub COI expires in 2 weeks`,
    3:  `Last call: your COI expires in ${days_left} day${days_left === 1 ? '' : 's'}`,
  };
  const headlineMap = {
    30: `Your COI expires in 30 days`,
    14: `2 weeks until your COI expires`,
    3:  `${days_left} day${days_left === 1 ? '' : 's'} until your COI expires`,
  };
  const body = `Hi ${first_name || 'there'},\n\nQuick heads-up: the Certificate of Insurance on your ${brand_name || 'brand'} Demohub profile expires on ${expires_label}.\n\nRetailers can't accept new demos from brands with an expired COI, and your verified badge disappears the moment it lapses. Take a minute now and you're set:\n\n1. Get an updated COI from your insurer (most brokers can re-issue same-day).\n2. Upload it to your profile: https://demohubhq.com/brand/dashboard#profile\n3. You're done — every Demohub retailer sees the new doc instantly.\n\nQuestions? Just reply to this email.\n\n— Demohub`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fbf7f0;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px;">
        <svg width="32" height="32" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
        <div style="font-weight:800;font-size:18px;letter-spacing:-0.04em;color:#0f2c17;">demohub</div>
      </div>
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#0f2c17;margin:0 0 14px;line-height:1.2;">${headlineMap[tier]}</h1>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 16px;">Hi ${first_name || 'there'},</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 16px;">Quick heads-up: the Certificate of Insurance on your <strong>${brand_name || 'brand'}</strong> Demohub profile expires on <strong>${expires_label}</strong>.</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 24px;">Retailers can't accept new demos from brands with an expired COI, and your <strong>verified badge disappears</strong> the moment it lapses. Take a minute now and you're set for the rest of the policy year.</p>
      <div style="background:white;border:1px solid rgba(15,44,23,0.08);border-radius:10px;padding:18px 22px;margin-bottom:24px;">
        <ol style="margin:0;padding-left:20px;font-size:14px;color:#3a3a36;line-height:1.7;">
          <li>Get an updated COI from your insurer (most brokers can re-issue same-day).</li>
          <li>Upload it to your profile.</li>
          <li>You're done — every Demohub retailer sees the new doc instantly.</li>
        </ol>
      </div>
      <a href="https://demohubhq.com/brand/dashboard#profile" style="display:inline-block;background:#0f2c17;color:white;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Upload new COI &rarr;</a>
      <p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:28px 0 0;">Questions? Just reply to this email — a human reads everything.</p>
    </div>
  </body></html>`;
  return { subject: subjectMap[tier], html, text: body };
}

function retailerCoiWarningEmail({ tier, retailer_name, brand_name, brand_contact_name, expires_label, days_left, upcoming_demo_label, admin_url }) {
  const subjectMap = {
    30: `${brand_name}'s COI expires in 30 days`,
    14: `Reminder: ${brand_name}'s COI expires in 2 weeks`,
    3:  `Last call: ${brand_name}'s COI expires in ${days_left} day${days_left === 1 ? '' : 's'}`,
  };
  const headlineMap = {
    30: `${brand_name}'s COI expires in 30 days`,
    14: `2 weeks until ${brand_name}'s COI expires`,
    3:  `${days_left} day${days_left === 1 ? '' : 's'} until ${brand_name}'s COI expires`,
  };
  const demoBlock = upcoming_demo_label
    ? `<div style="background:#fff3ed;border-left:4px solid #ed682f;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#a14e2a;line-height:1.5;"><strong>Heads up:</strong> you have an upcoming demo with this brand on <strong>${upcoming_demo_label}</strong>. If their COI lapses before then, you may need to reschedule.</div>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fbf7f0;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px;">
        <svg width="32" height="32" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
        <div style="font-weight:800;font-size:18px;letter-spacing:-0.04em;color:#0f2c17;">demohub</div>
      </div>
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#0f2c17;margin:0 0 14px;line-height:1.2;">${headlineMap[tier]}</h1>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 14px;">Hi ${retailer_name || 'there'},</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 18px;">The Certificate of Insurance on file for <strong>${brand_name}</strong>${brand_contact_name ? ' (' + brand_contact_name + ')' : ''} expires on <strong>${expires_label}</strong>.</p>
      ${demoBlock}
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 22px;">Two things you can do:</p>
      <div style="background:white;border:1px solid rgba(15,44,23,0.08);border-radius:10px;padding:18px 22px;margin-bottom:24px;">
        <ol style="margin:0;padding-left:20px;font-size:14px;color:#3a3a36;line-height:1.7;">
          <li>Reach out to ${brand_name} and ask them to renew their COI before the expiry date.</li>
          <li>Once they upload it, the compliance status updates automatically in your admin.</li>
        </ol>
      </div>
      <a href="${admin_url}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Open compliance dashboard &rarr;</a>
      <p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:28px 0 0;">Sent automatically by Demohub. You can adjust notification settings in your admin.</p>
    </div>
  </body></html>`;
  const text = `Hi ${retailer_name || 'there'},\n\nThe COI on file for ${brand_name}${brand_contact_name ? ' (' + brand_contact_name + ')' : ''} expires on ${expires_label}.\n\n${upcoming_demo_label ? `Heads up: you have an upcoming demo with this brand on ${upcoming_demo_label}. If their COI lapses before then, you may need to reschedule.\n\n` : ''}Two things to do:\n1. Reach out to ${brand_name} and ask them to renew before expiry.\n2. Once they upload it, your admin updates automatically.\n\nOpen your compliance dashboard: ${admin_url}\n\n— Demohub`;
  return { subject: subjectMap[tier], html, text };
}

async function sendWelcome({ to, subject, html, text }) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY missing — skipping welcome to', to); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_BOOKINGS, to, reply_to: REPLY_TO, subject, html, text }),
    });
    return r.ok;
  } catch (e) {
    console.warn('Welcome send failed:', e?.message || e);
    return false;
  }
}

const DEFAULT_DEMO_POLICY = 'Arrive 15 minutes before your slot to set up. Bring your own sampling supplies (cups, napkins, ice if needed). Coordinate with the floor lead on arrival. Keep the demo area clean, present products in branded packaging only, and break down promptly at end of slot. No solicitation outside the demo area.';
const DEFAULT_CANCELLATION_POLICY = 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules are welcome anytime.';

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str || '');
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const body = await readBody(req);
  const action = (req.query?.action || body.action || '').toString();

  try {
    if (action === 'signup') {
      const email = String(body.email || '').trim().toLowerCase();
      const companyName = String(body.company_name || '').trim();
      const contactName = String(body.contact_name || '').trim() || null;
      const phone = String(body.phone || '').trim() || null;
      let website = String(body.website || '').trim() || null;
      if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
      const defaultCategories = String(body.default_categories || '').trim() || null;
      if (!email || !companyName) return jsonResp(res, 400, { error: 'Missing email or company name' });
      if (!website) return jsonResp(res, 400, { error: 'Website is required so retailers can verify your brand' });

      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id`);
      const existing = (await lookupR.json())[0];
      let brandId;
      if (existing) {
        brandId = existing.id;
        const patch = { updated_at: new Date().toISOString() };
        if (contactName) patch.contact_name = contactName;
        if (phone) patch.phone = phone;
        if (website) patch.website = website;
        if (defaultCategories) patch.default_categories = defaultCategories;
        try { await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (_) {}
      } else {
        const createR = await sb('brands', {
          method: 'POST',
          body: JSON.stringify({ email, company_name: companyName, contact_name: contactName, phone, website, default_categories: defaultCategories }),
        });
        const created = await createR.json();
        if (!Array.isArray(created) || !created[0]) return jsonResp(res, 500, { error: 'Failed to create brand' });
        brandId = created[0].id;
        try {
          await sb('brand_members', {
            method: 'POST',
            body: JSON.stringify({ brand_id: brandId, email, role: 'owner', name: contactName }),
          });
        } catch (e) { console.warn('brand_members owner row creation failed:', e); }
      }

      const token = randomToken(24);
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await sb('brand_account_tokens', {
        method: 'POST',
        body: JSON.stringify({ brand_id: brandId, token, expires_at: expires }),
      });
      const link = `https://demohubhq.com/brand/verify?t=${token}`;
      await sendMagicLink(email, link, !existing);

      // Day-0 welcome — only on a brand-new signup. Best-effort, never blocks signup.
      if (!existing) {
        try {
          const firstName = (contactName || '').trim().split(/\s+/)[0] || companyName || 'there';
          const built = brandDay0Email({
            first_name: firstName,
            brand_name: companyName,
            example_retailer_url: 'https://demohubhq.com/r/gus',
          });
          const ok = await sendWelcome({ to: email, subject: built.subject, html: built.html, text: built.text });
          if (ok) {
            try {
              await sb(`brands?id=eq.${encodeURIComponent(brandId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_day0_sent_at: new Date().toISOString() }),
              });
            } catch (e) { console.warn('brand welcome_day0_sent_at stamp skipped:', e?.message || e); }
          }
        } catch (e) { console.warn('Brand day-0 welcome failed:', e?.message || e); }
      }
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return jsonResp(res, 400, { error: 'Missing email' });
      const lookupR = await sb(`brand_members?email=ilike.${encodeURIComponent(email)}&select=brand_id,email`);
      const member = (await lookupR.json())[0];
      if (member) {
        const token = randomToken(24);
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: member.brand_id, email: member.email, token, expires_at: expires }),
        });
        const link = `https://demohubhq.com/brand/verify?t=${token}`;
        await sendMagicLink(member.email, link, false);
      }
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'verify') {
      const token = String(body.token || req.query?.t || '').trim();
      if (!token) return jsonResp(res, 400, { error: 'Missing token' });
      const tR = await sb(`brand_account_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const tok = (await tR.json())[0];
      if (!tok || tok.used_at) return jsonResp(res, 401, { error: 'Invalid or used token' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 401, { error: 'Token expired' });
      await sb(`brand_account_tokens?id=eq.${tok.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used_at: new Date().toISOString() }),
      });
      let memberEmail = tok.email;
      if (!memberEmail) {
        const bR = await sb(`brands?id=eq.${tok.brand_id}&select=email`);
        const b = (await bR.json())[0];
        memberEmail = b?.email || null;
      }
      const sessionToken = randomToken(32);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: tok.brand_id, email: memberEmail, session_token: sessionToken, expires_at: expires }),
      });
      await sb(`brands?id=eq.${tok.brand_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_verified: true, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, session_token: sessionToken });
    }

    if (action === 'data') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const [profileR, demosR, contactsR] = await Promise.all([
        sb(`brands?id=eq.${brandId}&select=*`),
        sb(`demos?brand_id=eq.${brandId}&select=*,retailers(id,name,slug),venues(id,name,address)&order=demo_date.desc`),
        sb(`brand_contacts?brand_id=eq.${brandId}&select=retailer_id,created_at,retailers(id,name,slug)`),
      ]);
      const profile = (await profileR.json())[0] || null;
      const demos = await demosR.json();
      const contacts = await contactsR.json();
      return jsonResp(res, 200, { profile, demos, contacts });
    }

    if (action === 'agreement-list') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const rRows = await sb(`brand_retailer_agreements?brand_id=eq.${brandId}&select=*,retailers(id,name,slug,demo_policy,cancellation_policy)&order=signed_at.desc`);
      const rows = await rRows.json();
      const enriched = [];
      for (const r of (rows || [])) {
        const ret = r.retailers || {};
        const curHash = await sha256Hex((ret.demo_policy || DEFAULT_DEMO_POLICY) + '\n---\n' + (ret.cancellation_policy || DEFAULT_CANCELLATION_POLICY));
        enriched.push({
          ...r,
          is_active: !r.superseded_at,
          is_expired: new Date(r.expires_at).getTime() < Date.now(),
          is_current_policy: r.policy_hash === curHash,
        });
      }
      return jsonResp(res, 200, { ok: true, agreements: enriched });
    }

    if (action === 'profile-update') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const allowed = ['company_name', 'contact_name', 'phone', 'default_coi_url', 'default_coi_expires', 'default_product_info', 'default_categories', 'website', 'notification_prefs'];
      const patch = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (body[k] !== undefined) {
          if (k === 'notification_prefs') {
            patch[k] = body[k] && typeof body[k] === 'object' ? body[k] : null;
          } else {
            patch[k] = body[k] === '' ? null : body[k];
          }
        }
      }
      if (patch.website && typeof patch.website === 'string' && !/^https?:\/\//i.test(patch.website)) {
        patch.website = 'https://' + patch.website.trim();
      }
      const r = await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!r.ok) return jsonResp(res, 500, { error: 'Failed to update' });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'upload-avatar') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const dataUrl = String(body.image || '');
      const m = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return jsonResp(res, 400, { error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
      const mime = m[1];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 2 * 1024 * 1024) return jsonResp(res, 400, { error: 'Image too large — max 2MB' });
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: publicUrl, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, logo_url: publicUrl });
    }

    if (action === 'upload-coi') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const dataUrl = String(body.file || '');
      const m = dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return jsonResp(res, 400, { error: 'Invalid file — must be PDF, JPG, PNG, or WEBP' });
      const mime = m[1];
      const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 10 * 1024 * 1024) return jsonResp(res, 400, { error: 'File too large — max 10MB' });
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/coi-docs/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/coi-docs/${path}?v=${Date.now()}`;
      const originalName = String(body.filename || `certificate-of-insurance.${ext}`).slice(0, 120);
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_coi_url: publicUrl,
          coi_warn_30_sent_at: null,
          coi_warn_14_sent_at: null,
          coi_warn_3_sent_at: null,
          default_coi_filename: originalName,
          default_coi_mime: mime,
          updated_at: new Date().toISOString(),
        }),
      });
      return jsonResp(res, 200, { ok: true, coi_url: publicUrl, filename: originalName, mime });
    }

    if (action === 'remove-coi') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_coi_url: null,
          coi_warn_30_sent_at: null,
          coi_warn_14_sent_at: null,
          coi_warn_3_sent_at: null,
          default_coi_filename: null,
          default_coi_mime: null,
          default_coi_expires: null,
          updated_at: new Date().toISOString(),
        }),
      });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'remove-avatar') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: null, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'team-list') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const members = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&select=*&order=created_at`)).json();
      return jsonResp(res, 200, { ok: true, members, your_email: v.email });
    }

    if (action === 'team-invite') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim() || null;
      const role = body.role === 'viewer' ? 'viewer' : 'admin';
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return jsonResp(res, 400, { error: 'Valid email required' });
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role === 'viewer') return jsonResp(res, 403, { error: 'Viewers cannot invite team members' });
      const existing = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(email)}&select=id`)).json();
      if (Array.isArray(existing) && existing.length > 0) return jsonResp(res, 409, { error: 'That email is already on the team' });
      const createR = await sb('brand_members', {
        method: 'POST',
        body: JSON.stringify({ brand_id: v.brand_id, email, name, role, invited_by_email: v.email }),
      });
      const created = await createR.json();
      try {
        const brand = (await (await sb(`brands?id=eq.${v.brand_id}&select=company_name`)).json())[0];
        const token = randomToken(24);
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: v.brand_id, email, token, expires_at: expires }),
        });
        const link = `https://demohubhq.com/brand/verify?t=${token}`;
        if (RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: email,
              reply_to: REPLY_TO,
              subject: `You've been invited to ${brand?.company_name || 'a brand'}'s Demohub account`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c1c1a;">
                <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 12px;">You're invited.</h1>
                <p style="font-size:15px;line-height:1.5;margin:0 0 22px;color:#3a3a36;">${escapeText(v.email)} added you to <strong>${escapeText(brand?.company_name || 'their brand account')}</strong> on Demohub. Click below to sign in and start managing demos together.</p>
                <a href="${link}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 26px;border-radius:99px;text-decoration:none;font-weight:600;">Accept invite &rarr;</a>
                <p style="font-size:13px;color:#6b6a64;margin-top:32px;">Link expires in 30 minutes. If you weren't expecting this, you can ignore the email.</p>
              </div>`,
            }),
          });
        }
      } catch (e) { console.warn('Invitation email failed:', e); }
      return jsonResp(res, 200, { ok: true, member: Array.isArray(created) ? created[0] : null });
    }

    if (action === 'team-remove') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const memberId = String(body.member_id || '');
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return jsonResp(res, 403, { error: 'Only owners can remove team members' });
      const target = (await (await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}&select=*`)).json())[0];
      if (!target) return jsonResp(res, 404, { error: 'Member not found' });
      if (target.brand_id !== v.brand_id) return jsonResp(res, 403, { error: 'Wrong brand' });
      if (target.role === 'owner') return jsonResp(res, 400, { error: 'Cannot remove the owner' });
      await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      try { await sb(`brand_account_sessions?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(target.email)}`, { method: 'DELETE' }); } catch (_) {}
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'team-update-role') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const memberId = String(body.member_id || '');
      const role = body.role === 'viewer' ? 'viewer' : 'admin';
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return jsonResp(res, 403, { error: 'Only owners can change roles' });
      const target = (await (await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}&select=*`)).json())[0];
      if (!target || target.brand_id !== v.brand_id) return jsonResp(res, 404, { error: 'Member not found' });
      if (target.role === 'owner') return jsonResp(res, 400, { error: 'Cannot change owner role' });
      await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'logout') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      if (sessionToken) {
        await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}`, { method: 'DELETE' });
      }
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'logout-everywhere') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'cal') {
      const token = String((req.query?.token) || body.token || '').trim();
      if (!token) { res.status(400).send('Missing ?token= parameter. Get your calendar URL from your brand dashboard.'); return; }
      const pad = (n) => String(n).padStart(2, '0');
      const toICSDate = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
      const escapeICS = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
      const fold = (line) => { const out = []; for (let i = 0; i < line.length; i += 73) out.push((i === 0 ? '' : ' ') + line.slice(i, i + 73)); return out.join('\r\n'); };
      const parseDemoTime = (dateStr, timeStr) => {
        if (!dateStr) return null;
        const [Y, M, D] = dateStr.split('-').map(n => parseInt(n, 10));
        let H = 11, MIN = 0;
        if (timeStr) {
          const m = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
          if (m) {
            let h = parseInt(m[1], 10);
            const ampm = (m[3] || '').toUpperCase();
            if (ampm === 'PM' && h !== 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            H = h; MIN = parseInt(m[2], 10);
          }
        }
        return new Date(Date.UTC(Y, M - 1, D, H + 8, MIN, 0));
      };
      const sR = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(token)}&select=brand_id,expires_at`);
      const sess = (await sR.json())[0];
      if (!sess || new Date(sess.expires_at).getTime() < Date.now()) {
        res.status(401).send('Invalid or expired calendar URL. Generate a fresh one from your brand portal.');
        return;
      }
      const brandId = sess.brand_id;
      const bR = await sb(`brands?id=eq.${encodeURIComponent(brandId)}&select=company_name`);
      const brand = (await bR.json())[0];
      if (!brand) { res.status(404).send('Brand not found'); return; }
      const dR = await sb(`demos?brand_id=eq.${encodeURIComponent(brandId)}&status=in.(confirmed,completed,pending)&select=*,retailers(name),venues(name,address)&order=demo_date`);
      const demos = await dR.json();
      const now = new Date();
      const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'PRODID:-//Demohub//Brand calendar feed//EN',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        fold('X-WR-CALNAME:' + escapeICS(`${brand.company_name} — Demos`)),
        fold('X-WR-CALDESC:' + escapeICS(`All your Demohub demos across every retailer`)),
        'X-WR-TIMEZONE:America/Los_Angeles',
      ];
      (demos || []).forEach(d => {
        const start = parseDemoTime(d.demo_date, d.demo_time);
        if (!start) return;
        const durHours = d.duration_hours || 3;
        const end = new Date(start.getTime() + durHours * 60 * 60 * 1000);
        const retailerName = d.retailers?.name || 'Unknown retailer';
        const venueName = d.venues?.name || '';
        const venueAddr = d.venues?.address || '';
        const summary = `${retailerName}${venueName ? ' · ' + venueName : ''}`;
        const descParts = [];
        if (d.product) descParts.push('Product: ' + d.product);
        if (d.status) descParts.push('Status: ' + d.status);
        descParts.push('Booked via Demohub · demohubhq.com/brand');
        lines.push('BEGIN:VEVENT');
        lines.push('UID:brand-' + d.id + '@demohubhq.com');
        lines.push('DTSTAMP:' + toICSDate(now));
        lines.push('DTSTART:' + toICSDate(start));
        lines.push('DTEND:' + toICSDate(end));
        lines.push(fold('SUMMARY:' + escapeICS(summary)));
        if (venueAddr) lines.push(fold('LOCATION:' + escapeICS(`${venueName}, ${venueAddr}`)));
        else if (venueName) lines.push(fold('LOCATION:' + escapeICS(venueName)));
        lines.push(fold('DESCRIPTION:' + escapeICS(descParts.join('\\n'))));
        lines.push('STATUS:' + (d.status === 'confirmed' ? 'CONFIRMED' : d.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED'));
        lines.push('END:VEVENT');
      });
      lines.push('END:VCALENDAR');
      const out = lines.join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="demohub-demos.ics"`);
      res.setHeader('Cache-Control', 'public, max-age=900');
      res.status(200).send(out);
      return;
    }

    // -------- CRON: daily welcome-series job. Protected by CRON_SECRET. --------
    // Vercel cron invocations send: Authorization: Bearer <CRON_SECRET>
    if (action === 'cron') {
      const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
      const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!CRON_SECRET || provided !== CRON_SECRET) {
        return jsonResp(res, 401, { error: 'Unauthorized' });
      }

      // === HEARTBEAT: write a start row so we can verify the cron is actually firing ===
      const cronStartMs = Date.now();
      try {
        await sb('cron_heartbeat', {
          method: 'POST',
          body: JSON.stringify({ cron_name: 'daily', outcome: 'started' }),
        });
      } catch (_) { /* heartbeat is best-effort, don't block the work */ }

      const errors = [];
      let retailerDay3Sent = 0;
      let brandFirstDemoSent = 0;
      const nowIso = new Date().toISOString();

      // Retailer day-3 check-in
      try {
        const upperBound = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const lowerBound = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        const path = `retailers?select=id,name,billing_email,branding,slug,welcome_day0_sent_at,welcome_day3_sent_at,created_at` +
          `&created_at=lte.${encodeURIComponent(upperBound)}` +
          `&created_at=gte.${encodeURIComponent(lowerBound)}` +
          `&welcome_day0_sent_at=not.is.null` +
          `&welcome_day3_sent_at=is.null`;
        const rRes = await sb(path);
        const retailers = await rRes.json();
        await processBatched(Array.isArray(retailers) ? retailers : [], 5, async (r) => {
          try {
            const contactName = (r.branding && (r.branding.contact_name || r.branding.contactName)) || '';
            const firstName = String(contactName).trim().split(/\s+/)[0] || r.name || 'there';
            const built = retailerDay3Email({ first_name: firstName });
            const ok = await sendWelcome({ to: r.billing_email, subject: built.subject, html: built.html, text: built.text });
            if (ok) {
              await sb(`retailers?id=eq.${encodeURIComponent(r.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_day3_sent_at: nowIso }),
              });
              retailerDay3Sent++;
            } else {
              errors.push({ kind: 'retailer_day3', id: r.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'retailer_day3', id: r.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'retailer_day3_query', error: String(e?.message || e) });
      }

      // Brand: 24h after first confirmed demo
      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const bRes = await sb(`brands?select=id,email,company_name,contact_name,welcome_firstdemo_sent_at&welcome_firstdemo_sent_at=is.null`);
        const brands = await bRes.json();
        await processBatched(Array.isArray(brands) ? brands : [], 5, async (b) => {
          try {
            const dPath = `demos?brand_id=eq.${encodeURIComponent(b.id)}&status=eq.confirmed&confirmed_at=lte.${encodeURIComponent(cutoff)}&select=id,demo_date,confirmed_at,retailers(name)&order=confirmed_at.asc&limit=1`;
            const dRes = await sb(dPath);
            const demos = await dRes.json();
            const demo = Array.isArray(demos) ? demos[0] : null;
            if (!demo) return;
            const retailerName = demo.retailers?.name || 'your retailer';
            let demoDateLabel = demo.demo_date || '';
            try {
              if (demo.demo_date) {
                demoDateLabel = new Date(demo.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
              }
            } catch (_) {}
            const firstName = String(b.contact_name || '').trim().split(/\s+/)[0] || b.company_name || 'there';
            const built = brandFirstDemoEmail({ first_name: firstName, retailer_name: retailerName, demo_date: demoDateLabel });
            const ok = await sendWelcome({ to: b.email, subject: built.subject, html: built.html, text: built.text });
            if (ok) {
              await sb(`brands?id=eq.${encodeURIComponent(b.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_firstdemo_sent_at: nowIso }),
              });
              brandFirstDemoSent++;
            } else {
              errors.push({ kind: 'brand_firstdemo', id: b.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'brand_firstdemo', id: b.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'brand_firstdemo_query', error: String(e?.message || e) });
      }

      // COI expiry warnings: 30, 14, 3 days before default_coi_expires
      const coiSent = { tier30: 0, tier14: 0, tier3: 0 };
      const tiers = [
        { days: 30, col: 'coi_warn_30_sent_at', windowLow: 27, windowHigh: 30 },
        { days: 14, col: 'coi_warn_14_sent_at', windowLow: 11, windowHigh: 14 },
        { days: 3,  col: 'coi_warn_3_sent_at',  windowLow: 1,  windowHigh: 3  },
      ];
      for (const tier of tiers) {
        try {
          // Compute date window (inclusive)
          const lo = new Date(Date.now() + tier.windowLow * 86400000);
          const hi = new Date(Date.now() + tier.windowHigh * 86400000);
          const loStr = lo.toISOString().slice(0,10);
          const hiStr = hi.toISOString().slice(0,10);
          const path = `brands?select=id,email,company_name,contact_name,default_coi_expires,${tier.col}` +
            `&default_coi_url=not.is.null` +
            `&default_coi_expires=gte.${loStr}` +
            `&default_coi_expires=lte.${hiStr}` +
            `&${tier.col}=is.null`;
          const r = await sb(path);
          const list = await r.json();
          await processBatched(Array.isArray(list) ? list : [], 5, async (b) => {
            try {
              const ex = new Date(b.default_coi_expires + 'T00:00:00');
              const daysLeft = Math.max(0, Math.ceil((ex.getTime() - Date.now()) / 86400000));
              const expiresLabel = ex.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
              const firstName = String(b.contact_name || '').trim().split(/\s+/)[0] || b.company_name || 'there';
              const built = coiWarningEmail({ tier: tier.days, first_name: firstName, brand_name: b.company_name, expires_label: expiresLabel, days_left: daysLeft });
              const ok = await sendWelcome({ to: b.email, subject: built.subject, html: built.html, text: built.text });
              if (ok) {
                const patch = {}; patch[tier.col] = nowIso;
                await sb(`brands?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
                coiSent['tier' + tier.days]++;
              } else {
                errors.push({ kind: 'coi_warn_' + tier.days, id: b.id, error: 'send failed' });
              }
            } catch (e) {
              errors.push({ kind: 'coi_warn_' + tier.days, id: b.id, error: String(e?.message || e) });
            }
          });
        } catch (e) {
          errors.push({ kind: 'coi_warn_' + tier.days + '_query', error: String(e?.message || e) });
        }
      }

      // Retailer-side COI warnings: 30, 14, 3 days before compliance_records.expires_at
      const retailerCoiSent = { tier30: 0, tier14: 0, tier3: 0 };
      for (const tier of tiers) {
        try {
          const lo = new Date(Date.now() + tier.windowLow * 86400000);
          const hi = new Date(Date.now() + tier.windowHigh * 86400000);
          const loStr = lo.toISOString().slice(0,10);
          const hiStr = hi.toISOString().slice(0,10);
          const path = `compliance_records?select=id,retailer_id,brand_contact_id,expires_at,${tier.col}` +
            `&doc_type=eq.coi` +
            `&expires_at=gte.${loStr}` +
            `&expires_at=lte.${hiStr}` +
            `&${tier.col}=is.null`;
          const r = await sb(path);
          const list = await r.json();
          await processBatched(Array.isArray(list) ? list : [], 5, async (rec) => {
            try {
              // Look up retailer + brand contact
              const [rRes, bcRes] = await Promise.all([
                sb(`retailers?id=eq.${encodeURIComponent(rec.retailer_id)}&select=id,name,billing_email,slug,branding`),
                sb(`brand_contacts?id=eq.${encodeURIComponent(rec.brand_contact_id)}&select=id,name,company,email`),
              ]);
              const ret = (await rRes.json())[0];
              const bc = (await bcRes.json())[0];
              if (!ret || !ret.billing_email) {
                errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: 'no retailer billing_email' });
                return;
              }
              const brandName = (bc?.company) || (bc?.name) || 'a brand';
              const brandContactName = bc?.name || '';
              const ex = new Date(rec.expires_at + 'T00:00:00');
              const daysLeft = Math.max(0, Math.ceil((ex.getTime() - Date.now()) / 86400000));
              const expiresLabel = ex.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

              // Lookup upcoming demo with this brand (by company name match -> brands -> demos)
              let upcomingDemoLabel = '';
              try {
                if (bc?.company) {
                  const brandRes = await sb(`brands?company_name=eq.${encodeURIComponent(bc.company)}&select=id&limit=1`);
                  const brand = (await brandRes.json())[0];
                  if (brand?.id) {
                    const today = new Date().toISOString().slice(0,10);
                    const dRes = await sb(`demos?brand_id=eq.${encodeURIComponent(brand.id)}&retailer_id=eq.${encodeURIComponent(rec.retailer_id)}&status=in.(pending,confirmed)&demo_date=gte.${today}&select=demo_date&order=demo_date.asc&limit=1`);
                    const d = (await dRes.json())[0];
                    if (d?.demo_date) {
                      upcomingDemoLabel = new Date(d.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
                    }
                  }
                }
              } catch (_) { /* demo enrichment is nice-to-have */ }

              const retailerDisplayName = (ret.branding && (ret.branding.contact_name || ret.branding.contactName)) || ret.name || '';
              const firstName = String(retailerDisplayName).trim().split(/\s+/)[0] || ret.name || 'there';
              const adminUrl = `https://demohubhq.com/r/${ret.slug /* slug required */}/admin`;
              const built = retailerCoiWarningEmail({
                tier: tier.days, retailer_name: firstName, brand_name: brandName,
                brand_contact_name: brandContactName, expires_label: expiresLabel,
                days_left: daysLeft, upcoming_demo_label: upcomingDemoLabel, admin_url: adminUrl,
              });
              const ok = await sendWelcome({ to: ret.billing_email, subject: built.subject, html: built.html, text: built.text });
              if (ok) {
                const patch = {}; patch[tier.col] = nowIso;
                await sb(`compliance_records?id=eq.${encodeURIComponent(rec.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
                retailerCoiSent['tier' + tier.days]++;
              } else {
                errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: 'send failed' });
              }
            } catch (e) {
              errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: String(e?.message || e) });
            }
          });
        } catch (e) {
          errors.push({ kind: 'retailer_coi_warn_' + tier.days + '_query', error: String(e?.message || e) });
        }
      }

      // ===== Monthly retailer overview (sent once per month, ~1st of each month) =====
      let monthlySummarySent = 0;
      try {
        const now = new Date();
        // Eligible: retailers with monthly_summary_enabled=true and last_sent_at < 28 days ago (or never)
        const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
        const path = `retailers?select=id,name,billing_email,slug,monthly_summary_enabled,monthly_summary_last_sent_at` +
          `&monthly_summary_enabled=eq.true` +
          `&billing_email=not.is.null` +
          `&or=(monthly_summary_last_sent_at.is.null,monthly_summary_last_sent_at.lt.${encodeURIComponent(twentyEightDaysAgo)})`;
        const eligibleR = await sb(path);
        const eligible = await eligibleR.json();
        const monthLabel = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        await processBatched(Array.isArray(eligible) ? eligible : [], 5, async (ret) => {
          try {
            // Compute summary metrics for last 30 days
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const [demosCompletedR, demoFeesR, pendingBookingsR, expiringCoiR] = await Promise.all([
              sb(`demos?retailer_id=eq.${encodeURIComponent(ret.id)}&status=eq.completed&demo_date=gte.${since}&select=demo_fee`),
              sb(`bookings?retailer_id=eq.${encodeURIComponent(ret.id)}&status=eq.pending&select=id`),
              sb(`compliance_records?retailer_id=eq.${encodeURIComponent(ret.id)}&doc_type=eq.coi&expires_at=lt.${new Date(Date.now() + 45 * 86400000).toISOString().slice(0,10)}&select=id`),
              sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(ret.id)}&created_at=gte.${since}&select=id`),
            ]);
            const demosCompleted = await demosCompletedR.json();
            const pendingBookings = await pendingBookingsR.json();
            const expiringCoi = await expiringCoiR.json();
            const newBrands = await (await sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(ret.id)}&created_at=gte.${since}&select=id`)).json();
            const totalFees = Array.isArray(demosCompleted) ? demosCompleted.reduce((s, d) => s + (parseFloat(d.demo_fee) || 0), 0) : 0;
            const demosCount = Array.isArray(demosCompleted) ? demosCompleted.length : 0;
            const pendingCount = Array.isArray(pendingBookings) ? pendingBookings.length : 0;
            const expCoiCount = Array.isArray(expiringCoi) ? expiringCoi.length : 0;
            const newBrandsCount = Array.isArray(newBrands) ? newBrands.length : 0;
            const adminUrl = `https://demohubhq.com/r/${ret.slug}/admin`;
            const subject = `${monthLabel} at ${ret.name} — ${demosCount} demo${demosCount === 1 ? '' : 's'}, $${totalFees.toFixed(0)} in fees`;
            const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;"><svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg></td>
<td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 36px 8px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">Monthly overview · ${escapeText(monthLabel)}</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">Here's what happened last month at ${escapeText(ret.name)}.</h1>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:18px 0 6px;">
<tr>
  <td style="width:50%;padding:14px 12px;text-align:center;background:#f9f7f2;border-radius:10px 0 0 10px;">
    <div style="font-size:1.8rem;font-weight:800;color:#0f2c17;line-height:1;">${demosCount}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Demos completed</div>
  </td>
  <td style="width:50%;padding:14px 12px;text-align:center;background:#f9f7f2;border-radius:0 10px 10px 0;border-left:1px solid #ede3d0;">
    <div style="font-size:1.8rem;font-weight:800;color:#0f2c17;line-height:1;">$${totalFees.toFixed(0)}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Demo fees collected</div>
  </td>
</tr>
</table>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 18px;">
<tr>
  <td style="width:33%;padding:12px 8px;text-align:center;">
    <div style="font-size:1.3rem;font-weight:700;color:#0f2c17;line-height:1;">${pendingCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Pending bookings</div>
  </td>
  <td style="width:33%;padding:12px 8px;text-align:center;border-left:1px solid #ede3d0;">
    <div style="font-size:1.3rem;font-weight:700;color:${expCoiCount > 0 ? '#a14e2a' : '#0f2c17'};line-height:1;">${expCoiCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">COIs expiring &lt; 45d</div>
  </td>
  <td style="width:33%;padding:12px 8px;text-align:center;border-left:1px solid #ede3d0;">
    <div style="font-size:1.3rem;font-weight:700;color:#0f2c17;line-height:1;">${newBrandsCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">New brand contacts</div>
  </td>
</tr>
</table>
${pendingCount > 0 ? `<p style="background:#fff3ed;border-left:3px solid #ed682f;padding:12px 16px;border-radius:6px;font-size:13px;color:#3a3a36;margin:14px 0;">${pendingCount} booking${pendingCount === 1 ? ' is' : 's are'} waiting for your confirmation. <a href="${adminUrl}" style="color:#a14e2a;font-weight:700;">Review them &rarr;</a></p>` : ''}
${expCoiCount > 0 ? `<p style="background:#fff3ed;border-left:3px solid #ed682f;padding:12px 16px;border-radius:6px;font-size:13px;color:#3a3a36;margin:14px 0;">${expCoiCount} brand${expCoiCount === 1 ? '' : 's'} ha${expCoiCount === 1 ? 's' : 've'} a COI expiring within 45 days. Brands receive automatic 30/14/3 day warnings, but you can preview which here. <a href="${adminUrl}" style="color:#a14e2a;font-weight:700;">View compliance &rarr;</a></p>` : ''}
<p style="font-size:14px;color:#3a3a36;line-height:1.55;margin:18px 0;">Open your admin to dig into specific demos, brand contacts, payouts, and more.</p>
<p style="margin:0 0 18px;"><a href="${adminUrl}" style="background:#0f2c17;color:white;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Open admin &rarr;</a></p>
<p style="font-size:12px;color:#6b6a64;line-height:1.5;margin:20px 0 0;">These monthly overviews are on by default. You can turn them off anytime from Settings &rarr; Notifications.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; [Mailing address pending — please update via virtual mailbox or PO Box. Required by CAN-SPAM. Contact david@demohubhq.com for current address.]<br>You're receiving this monthly overview because you have a Demohub admin account. Manage in Settings &rarr; Notifications.</td></tr>
</table></body></html>`;
            const ok = await sendWelcome({ to: ret.billing_email, subject, html: htmlBody, text: `Your ${monthLabel} overview at ${ret.name}: ${demosCount} demos completed, $${totalFees.toFixed(0)} in fees, ${pendingCount} pending bookings. Open ${adminUrl}` });
            if (ok) {
              await sb(`retailers?id=eq.${encodeURIComponent(ret.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ monthly_summary_last_sent_at: new Date().toISOString() }),
              });
              monthlySummarySent++;
            } else {
              errors.push({ kind: 'monthly_summary', id: ret.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'monthly_summary', id: ret.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'monthly_summary_query', error: String(e?.message || e) });
      }

      // === HEARTBEAT: write success row with summary ===
      try {
        await sb('cron_heartbeat', {
          method: 'POST',
          body: JSON.stringify({
            cron_name: 'daily',
            outcome: 'succeeded',
            duration_ms: Date.now() - cronStartMs,
            summary: { retailerDay3Sent, brandFirstDemoSent, coiSent, retailerCoiSent, monthlySummarySent, errors: errors.length },
          }),
        });
      } catch (_) { /* best-effort */ }
      return jsonResp(res, 200, { ok: true, retailerDay3Sent, brandFirstDemoSent, coiSent, retailerCoiSent, errors, ran_at: nowIso });
    }

    return jsonResp(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('brand-account error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
