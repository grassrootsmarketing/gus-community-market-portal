// /api/apply-migrations — Owner-authed database migration runner.
// POST { session_id } → applies any un-applied migrations from the array below.
//
// Requires POSTGRES_URL env var (get from Supabase → Settings → Database → Session pooler).
// Requires owner session token (call /api/admin-auth?action=owner-login first).
//
// Migrations are additive + idempotent. Each has a unique name. Applied ones are
// recorded in the schema_migrations table so they run at most once.

import { Client } from 'pg';

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POSTGRES_URL = process.env.POSTGRES_URL;

// ==============================================================
// MIGRATIONS — append new ones here. NEVER edit or reorder existing ones.
// Each migration runs at most once (tracked in schema_migrations).
// SQL should be idempotent (use IF NOT EXISTS wherever possible) as a safety net.
// ==============================================================
const MIGRATIONS = [
  {
    name: '001_schema_migrations_table',
    sql: `CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );`,
  },
  {
    name: '002_admin_tokens_code',
    sql: `ALTER TABLE admin_tokens ADD COLUMN IF NOT EXISTS code TEXT;
          CREATE INDEX IF NOT EXISTS admin_tokens_code_lookup
            ON admin_tokens (code, email)
            WHERE code IS NOT NULL AND used_at IS NULL;`,
  },
  {
    name: '003_brands_needs_electricity',
    sql: `ALTER TABLE brands ADD COLUMN IF NOT EXISTS needs_electricity BOOLEAN NOT NULL DEFAULT false;`,
  },
  {
    name: '004_retailers_policy_files',
    sql: `ALTER TABLE retailers
            ADD COLUMN IF NOT EXISTS cancellation_policy_url TEXT,
            ADD COLUMN IF NOT EXISTS cancellation_policy_filename TEXT,
            ADD COLUMN IF NOT EXISTS demo_policy_url TEXT,
            ADD COLUMN IF NOT EXISTS demo_policy_filename TEXT;
          ALTER TABLE brand_retailer_agreements
            ADD COLUMN IF NOT EXISTS cancellation_policy_url_snapshot TEXT,
            ADD COLUMN IF NOT EXISTS demo_policy_url_snapshot TEXT;`,
  },
];

// ==============================================================

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

async function verifyOwnerSession(session_id) {
  if (!session_id) return null;
  try {
    const sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
    const s = Array.isArray(sessions) ? sessions[0] : null;
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    // Owner sessions have retailer_id = NULL
    if (s.retailer_id) return null;
    return { email: s.email };
  } catch { return null; }
}

function jsonResp(res, code, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(code).send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // GET returns the pending vs. applied status without running anything
    return await getStatus(req, res);
  }
  if (req.method !== 'POST') return jsonResp(res, 405, { error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const session_id = (req.query?.session_id || body.session_id || '').toString();

  const owner = await verifyOwnerSession(session_id);
  if (!owner) return jsonResp(res, 401, { error: 'Owner authentication required' });

  if (!POSTGRES_URL) {
    return jsonResp(res, 500, {
      error: 'POSTGRES_URL env var not configured. Get the Session pooler connection string from Supabase → Settings → Database and add it as POSTGRES_URL in Vercel env vars.',
    });
  }

  const client = new Client({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  const results = [];
  try {
    await client.connect();

    // Ensure schema_migrations table exists FIRST (bootstrap)
    await client.query(MIGRATIONS[0].sql);

    // Get list of already-applied names
    const appliedRes = await client.query('SELECT name FROM schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map(r => r.name));

    // Record the bootstrap as applied if not already
    if (!appliedSet.has(MIGRATIONS[0].name)) {
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [MIGRATIONS[0].name]);
      appliedSet.add(MIGRATIONS[0].name);
      results.push({ name: MIGRATIONS[0].name, status: 'applied', bootstrap: true });
    }

    // Run each remaining migration in order
    for (const m of MIGRATIONS.slice(1)) {
      if (appliedSet.has(m.name)) {
        results.push({ name: m.name, status: 'skipped' });
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
        results.push({ name: m.name, status: 'applied' });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        results.push({ name: m.name, status: 'failed', error: e.message || String(e) });
        // Stop on first failure — no partial application
        break;
      }
    }

    await client.end();
    return jsonResp(res, 200, { ok: true, applied_by: owner.email, results });
  } catch (e) {
    try { await client.end(); } catch(_) {}
    return jsonResp(res, 500, { error: `Migration runner failed: ${e.message || e}` });
  }
}

async function getStatus(req, res) {
  const session_id = (req.query?.session_id || '').toString();
  const owner = await verifyOwnerSession(session_id);
  if (!owner) return jsonResp(res, 401, { error: 'Owner authentication required' });
  if (!POSTGRES_URL) {
    return jsonResp(res, 200, {
      ok: false,
      configured: false,
      pending: MIGRATIONS.map(m => m.name),
      applied: [],
      note: 'POSTGRES_URL not configured. Add it in Vercel env vars.',
    });
  }
  const client = new Client({ connectionString: POSTGRES_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    // Ensure table exists so the query doesn't fail on first run
    await client.query(MIGRATIONS[0].sql);
    const appliedRes = await client.query('SELECT name, applied_at FROM schema_migrations ORDER BY applied_at');
    await client.end();
    const appliedMap = Object.fromEntries(appliedRes.rows.map(r => [r.name, r.applied_at]));
    return jsonResp(res, 200, {
      ok: true,
      configured: true,
      migrations: MIGRATIONS.map(m => ({
        name: m.name,
        applied: !!appliedMap[m.name],
        applied_at: appliedMap[m.name] || null,
      })),
    });
  } catch (e) {
    try { await client.end(); } catch(_) {}
    return jsonResp(res, 500, { error: `Status check failed: ${e.message || e}` });
  }
}
