// /api/brand-agreement — Brand × retailer demo-conduct contract
//
// Lifecycle:
//   - At first booking, brand types their full name → agreement created
//   - On every booking after, we check: still active? policy unchanged? not expired?
//   - If anything fails the check, the booking page re-prompts before submit
//
// Audit trail: old agreements get superseded_at + superseded_by set; never deleted.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DEFAULT_DEMO_POLICY = 'Arrive 15 minutes before your slot to set up. Bring your own sampling supplies (cups, napkins, ice if needed). Coordinate with the floor lead on arrival. Keep the demo area clean, present products in branded packaging only, and break down promptly at end of slot. No solicitation outside the demo area.';
const DEFAULT_CANCELLATION_POLICY = 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules are welcome anytime.';

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

async function sha256Hex(str) {
  // Node 18+ has globalThis.crypto.subtle
  const enc = new TextEncoder().encode(str || '');
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computePolicyHash(demoPolicy, cancellationPolicy) {
  return sha256Hex((demoPolicy || '') + '\n---\n' + (cancellationPolicy || ''));
}

// Resolve retailer_id from either id or slug
async function resolveRetailer(input) {
  if (!input) return null;
  if (input.retailer_id) {
    const r = await sb(`retailers?id=eq.${encodeURIComponent(input.retailer_id)}&select=id,name,slug,demo_policy,cancellation_policy`);
    return Array.isArray(r) ? r[0] : null;
  }
  if (input.retailer_slug) {
    const r = await sb(`retailers?slug=eq.${encodeURIComponent(input.retailer_slug)}&select=id,name,slug,demo_policy,cancellation_policy`);
    return Array.isArray(r) ? r[0] : null;
  }
  return null;
}

// Resolve brand_id from either id or email (creates nothing — caller handles creation)
async function resolveBrand(input) {
  if (!input) return null;
  if (input.brand_id) {
    const r = await sb(`brands?id=eq.${encodeURIComponent(input.brand_id)}&select=id,name,email`);
    return Array.isArray(r) ? r[0] : null;
  }
  if (input.brand_email) {
    const r = await sb(`brands?email=eq.${encodeURIComponent(String(input.brand_email).toLowerCase())}&select=id,name,email`);
    return Array.isArray(r) ? r[0] : null;
  }
  return null;
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || null;
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

    // ---- CHECK: does this brand × retailer have a current valid agreement? ----
    // Returns { has_active, needs_re_sign, reason, current_agreement, policies }
    // Used by the booking flow to decide whether to prompt for re-sign.
    if (action === 'check') {
      const retailer = await resolveRetailer(body);
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });
      const brand = await resolveBrand(body);

      const demoPolicy = retailer.demo_policy || DEFAULT_DEMO_POLICY;
      const cancelPolicy = retailer.cancellation_policy || DEFAULT_CANCELLATION_POLICY;
      const currentHash = await computePolicyHash(demoPolicy, cancelPolicy);

      const policies = {
        demo_policy: demoPolicy,
        cancellation_policy: cancelPolicy,
        policy_hash: currentHash,
        retailer_name: retailer.name,
      };

      // If we couldn't resolve a brand (new email, not yet in brands table) — no agreement possible
      if (!brand) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'no_brand_account', policies });
      }

      const active = await sb(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brand.id)}&retailer_id=eq.${encodeURIComponent(retailer.id)}&superseded_at=is.null&select=*&order=signed_at.desc&limit=1`);
      const a = Array.isArray(active) ? active[0] : null;

      if (!a) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'never_signed', policies });
      }
      if (new Date(a.expires_at).getTime() < Date.now()) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'expired', current_agreement: a, policies });
      }
      if (a.policy_hash !== currentHash) {
        return res.status(200).json({ ok: true, has_active: false, needs_re_sign: true, reason: 'policy_changed', current_agreement: a, policies });
      }

      return res.status(200).json({ ok: true, has_active: true, needs_re_sign: false, current_agreement: a, policies });
    }

    // ---- SIGN: brand signs the current policy snapshot ----
    // Required: brand_id (or brand_email), retailer_id (or retailer_slug), signed_name
    // Effect: supersedes any existing active agreement, inserts a new active one
    if (action === 'sign') {
      const { signed_name } = body || {};
      if (!signed_name || String(signed_name).trim().length < 2) {
        return res.status(400).json({ error: 'signed_name required' });
      }
      const retailer = await resolveRetailer(body);
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });
      const brand = await resolveBrand(body);
      if (!brand) return res.status(404).json({ error: 'Brand not found — create brand account first' });

      const demoPolicy = retailer.demo_policy || DEFAULT_DEMO_POLICY;
      const cancelPolicy = retailer.cancellation_policy || DEFAULT_CANCELLATION_POLICY;
      const policyHash = await computePolicyHash(demoPolicy, cancelPolicy);

      // Find any existing active agreement to supersede atomically.
      // Supabase REST doesn't expose transactions; sequence the writes carefully.
      const active = await sb(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brand.id)}&retailer_id=eq.${encodeURIComponent(retailer.id)}&superseded_at=is.null&select=id&limit=1`);
      const priorId = Array.isArray(active) && active[0] ? active[0].id : null;

      if (priorId) {
        await sb(`brand_retailer_agreements?id=eq.${encodeURIComponent(priorId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ superseded_at: new Date().toISOString() }),
        });
      }

      const created = await sb(`brand_retailer_agreements`, {
        method: 'POST',
        body: JSON.stringify({
          brand_id: brand.id,
          retailer_id: retailer.id,
          signed_name: String(signed_name).trim(),
          signed_email: brand.email,
          signed_ip: clientIp(req),
          signed_user_agent: req.headers['user-agent'] || null,
          demo_policy_snapshot: demoPolicy,
          cancellation_policy_snapshot: cancelPolicy,
          policy_hash: policyHash,
        }),
      });
      const row = Array.isArray(created) ? created[0] : null;

      // Backfill superseded_by on the prior row so the chain is queryable
      if (priorId && row?.id) {
        try {
          await sb(`brand_retailer_agreements?id=eq.${encodeURIComponent(priorId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ superseded_by: row.id }),
          });
        } catch (_) {}
      }

      return res.status(200).json({ ok: true, agreement: row });
    }

    // ---- LIST (brand-side): all retailers this brand has signed with ----
    // Brand portal calls this to populate the new Agreements tab.
    if (action === 'list') {
      const brand = await resolveBrand(body);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const rows = await sb(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brand.id)}&select=*,retailers(id,name,slug,demo_policy,cancellation_policy)&order=signed_at.desc`);
      // For each row compute is_current_policy + is_expired so the UI doesn't need to
      const enriched = [];
      for (const r of (rows || [])) {
        const ret = r.retailers || {};
        const curHash = await computePolicyHash(ret.demo_policy || DEFAULT_DEMO_POLICY, ret.cancellation_policy || DEFAULT_CANCELLATION_POLICY);
        enriched.push({
          ...r,
          is_active: !r.superseded_at,
          is_expired: new Date(r.expires_at).getTime() < Date.now(),
          is_current_policy: r.policy_hash === curHash,
        });
      }
      return res.status(200).json({ ok: true, agreements: enriched });
    }

    // ---- RETAILER-LIST: retailer admin sees who has signed for them ----
    // Requires the retailer admin's session_id (verified via /api/admin-auth pattern).
    if (action === 'retailer-list') {
      const { session_id } = body || {};
      if (!session_id) return res.status(400).json({ error: 'session_id required' });

      const sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=email,retailer_id,expires_at`);
      const sess = Array.isArray(sessions) ? sessions[0] : null;
      if (!sess) return res.status(401).json({ error: 'Invalid session' });
      if (sess.expires_at && new Date(sess.expires_at).getTime() < Date.now()) {
        return res.status(401).json({ error: 'Session expired' });
      }
      const retailerId = sess.retailer_id;
      const rows = await sb(`brand_retailer_agreements?retailer_id=eq.${encodeURIComponent(retailerId)}&superseded_at=is.null&select=*,brands(id,name,email)&order=signed_at.desc`);
      return res.status(200).json({ ok: true, agreements: rows || [] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('brand-agreement error:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
