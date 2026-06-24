// /api/brand-account
// Magic-link auth + profile CRUD for cross-retailer brand accounts.
// Actions: signup, login, verify, data, profile-update, demos, logout
// Privacy: NEVER expose brand_id to retailer-side endpoints. All retailer
// admin queries continue to filter by retailer_id only.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Demohub <noreply@demohubhq.com>';
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
// Returns { brand_id, email } or null — for actions that need to know the acting member
async function verifySessionFull(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,email,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return { brand_id: s.brand_id, email: s.email };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const body = await readBody(req);
  const action = (req.query?.action || body.action || '').toString();

  try {
    // -------- SIGNUP: create brand + send magic link (anti-enum: same response either way) --------
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

      // upsert by email
      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id`);
      const existing = (await lookupR.json())[0];
      let brandId;
      if (existing) {
        brandId = existing.id;
        // Fill in any newly-provided fields that weren't set before
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
        // Also create an 'owner' member row so multi-user team management works from day 1
        try {
          await sb('brand_members', {
            method: 'POST',
            body: JSON.stringify({ brand_id: brandId, email, role: 'owner', name: contactName }),
          });
        } catch (e) { console.warn('brand_members owner row creation failed:', e); }
      }

      // create magic link token
      const token = randomToken(24);
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await sb('brand_account_tokens', {
        method: 'POST',
        body: JSON.stringify({ brand_id: brandId, token, expires_at: expires }),
      });
      const link = `https://demohubhq.com/brand/verify?t=${token}`;
      await sendMagicLink(email, link, !existing);
      return jsonResp(res, 200, { ok: true });
    }

    // -------- LOGIN: existing brand OR team member (anti-enum) --------
    // Matches against brand_members.email — that table includes the brand's primary email (owner)
    // plus any teammates the brand owner has invited.
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

    // -------- VERIFY: exchange magic-link token for session --------
    if (action === 'verify') {
      const token = String(body.token || req.query?.t || '').trim();
      if (!token) return jsonResp(res, 400, { error: 'Missing token' });
      const tR = await sb(`brand_account_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const tok = (await tR.json())[0];
      if (!tok || tok.used_at) return jsonResp(res, 401, { error: 'Invalid or used token' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 401, { error: 'Token expired' });
      // mark used
      await sb(`brand_account_tokens?id=eq.${tok.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used_at: new Date().toISOString() }),
      });
      // Look up brand's primary email as fallback (older tokens don't have email column populated)
      let memberEmail = tok.email;
      if (!memberEmail) {
        const bR = await sb(`brands?id=eq.${tok.brand_id}&select=email`);
        const b = (await bR.json())[0];
        memberEmail = b?.email || null;
      }
      // create session
      const sessionToken = randomToken(32);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: tok.brand_id, email: memberEmail, session_token: sessionToken, expires_at: expires }),
      });
      // mark brand verified
      await sb(`brands?id=eq.${tok.brand_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_verified: true, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, session_token: sessionToken });
    }

    // -------- DATA: fetch brand profile + all demos + retailer relationships --------
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

    // -------- PROFILE-UPDATE: brand edits their own profile --------
    if (action === 'profile-update') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });

      const allowed = ['company_name', 'contact_name', 'phone', 'default_coi_url', 'default_coi_expires', 'default_product_info', 'default_categories', 'website', 'notification_prefs'];
      const patch = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (body[k] !== undefined) {
          // notification_prefs is JSONB — accept the object as-is. Other fields: empty string => null.
          if (k === 'notification_prefs') {
            patch[k] = body[k] && typeof body[k] === 'object' ? body[k] : null;
          } else {
            patch[k] = body[k] === '' ? null : body[k];
          }
        }
      }
      // Normalize website URL: prepend https:// if missing
      if (patch.website && typeof patch.website === 'string' && !/^https?:\/\//i.test(patch.website)) {
        patch.website = 'https://' + patch.website.trim();
      }
      const r = await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!r.ok) return jsonResp(res, 500, { error: 'Failed to update' });
      return jsonResp(res, 200, { ok: true });
    }

    // -------- UPLOAD-AVATAR: brand uploads/replaces their logo --------
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

      // Upload to Supabase Storage. Path: brands/{brand_id}.{ext} — use upsert so re-upload overwrites.
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY,
          'Content-Type': mime,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
      }
      // Public URL + cache-busting query so the browser picks up the new image immediately
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: publicUrl, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, logo_url: publicUrl });
    }

    // -------- UPLOAD-COI: upload certificate of insurance (PDF or image) --------
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

      // Path: brands/{brand_id}.{ext} — upsert overwrites prior COI
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/coi-docs/${path}?upsert=true`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          apikey: SUPABASE_SERVICE_KEY,
          'Content-Type': mime,
          'x-upsert': 'true',
        },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/coi-docs/${path}?v=${Date.now()}`;
      // Store the URL + filename + mime so we can render a clean filename later
      const originalName = String(body.filename || `certificate-of-insurance.${ext}`).slice(0, 120);
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_coi_url: publicUrl,
          default_coi_filename: originalName,
          default_coi_mime: mime,
          updated_at: new Date().toISOString(),
        }),
      });
      return jsonResp(res, 200, { ok: true, coi_url: publicUrl, filename: originalName, mime });
    }

    // -------- REMOVE-COI: clear the brand's COI --------
    if (action === 'remove-coi') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          default_coi_url: null,
          default_coi_filename: null,
          default_coi_mime: null,
          default_coi_expires: null,
          updated_at: new Date().toISOString(),
        }),
      });
      return jsonResp(res, 200, { ok: true });
    }

    // -------- REMOVE-AVATAR: clear the brand's logo --------
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

    // -------- TEAM-LIST: list all members of the current brand --------
    if (action === 'team-list') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const members = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&select=*&order=created_at`)).json();
      return jsonResp(res, 200, { ok: true, members, your_email: v.email });
    }

    // -------- TEAM-INVITE: add a teammate (owner/admin only) --------
    if (action === 'team-invite') {
      const v = await verifySessionFull((req.query?.session_id || body.session_id || '').toString());
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim() || null;
      const role = body.role === 'viewer' ? 'viewer' : 'admin';
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return jsonResp(res, 400, { error: 'Valid email required' });

      // Only owners/admins can invite (not viewers)
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role === 'viewer') return jsonResp(res, 403, { error: 'Viewers cannot invite team members' });

      // Dup check
      const existing = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(email)}&select=id`)).json();
      if (Array.isArray(existing) && existing.length > 0) return jsonResp(res, 409, { error: 'That email is already on the team' });

      const createR = await sb('brand_members', {
        method: 'POST',
        body: JSON.stringify({ brand_id: v.brand_id, email, name, role, invited_by_email: v.email }),
      });
      const created = await createR.json();

      // Send invitation magic link
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

    // -------- TEAM-REMOVE: remove a teammate (owner only; can't remove owner) --------
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
      // Revoke any active sessions for that member email
      try { await sb(`brand_account_sessions?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(target.email)}`, { method: 'DELETE' }); } catch (_) {}
      return jsonResp(res, 200, { ok: true });
    }

    // -------- TEAM-UPDATE-ROLE: change a member's role (owner only) --------
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

    // -------- LOGOUT --------
    if (action === 'logout') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      if (sessionToken) {
        await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}`, { method: 'DELETE' });
      }
      return jsonResp(res, 200, { ok: true });
    }

    // -------- LOGOUT-EVERYWHERE: kill ALL sessions for this brand --------
    if (action === 'logout-everywhere') {
      const sessionToken = (req.query?.session_id || body.session_id || '').toString();
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' });
      return jsonResp(res, 200, { ok: true });
    }

    // -------- CAL: iCal feed of all this brand's demos across every retailer --------
    // Token-based (calendar apps can't send headers). URL: /api/brand-account?action=cal&token=...
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
        return new Date(Date.UTC(Y, M - 1, D, H + 8, MIN, 0)); // assume PST
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

    return jsonResp(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('brand-account error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
