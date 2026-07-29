// api/_env.js — THE binding layer. Single source of truth for every external target.
//
// This replaces the previous _env.js, which validated that variables were non-empty and blocked one
// hardcoded production host for code that voluntarily called assertNotProduction(). That was a
// useful early guard but it could not have prevented the incident: 37 files read process.env
// directly and never called it, it matched hosts by substring, and its hardcoded host becomes
// meaningless the moment the project is replaced.
//
// DESIGN RULE: a configuration value is a CLAIM. This module refuses to act on claims alone.
// It parses the URL, checks the claimed project ref against the deployment target, then asks the
// database what it thinks it is, and only proceeds when the two agree. A mismatch returns
// 503 binding_invalid BEFORE any database write, Stripe call, email, file operation, or webhook ack.
//
// Codex §8.2 requirements 1-12 are implemented below and marked [R1]..[R12].

// ---------------------------------------------------------------------------
// [R5] Target map. The ONLY place a project ref may appear in application code.
// ---------------------------------------------------------------------------
// Populated at R3 once the clean projects exist. Until then both are null, which means production
// validation CANNOT pass with a placeholder — required by Codex §8.2 closing paragraph.
export const TARGETS = {
  production: {
    projectRef: null,          // R3: exact new Production ref
    dbEnvironment: 'production',
    stripeMode: 'live',
    emailMode: 'real',
  },
  preview: {
    projectRef: null,          // R3: exact new Staging ref
    dbEnvironment: 'staging',
    stripeMode: 'test',
    emailMode: 'sink',
  },
  development: {
    projectRef: null,          // set per-developer via DEV_SUPABASE_REF; never a shared default
    dbEnvironment: 'development',
    stripeMode: 'test',
    emailMode: 'sink',
  },
};

// Refs that must NEVER be accepted again, whatever configuration says. Retired by the incident.
export const RETIRED_REFS = new Set([
  'ecapmcyumpjjgjwuokyv',   // old production
  'eubbgurdwqmwqduamwhn',   // old staging
]);

export class BindingError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'BindingError';
    this.code = code;
    this.detail = detail || null;
  }
}

// ---------------------------------------------------------------------------
// [R3] Parse, never substring-match.
// ---------------------------------------------------------------------------
export function parseProjectRef(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); }
  catch { throw new BindingError('supabase_url_malformed'); }

  if (u.protocol !== 'https:') throw new BindingError('supabase_url_not_https');

  const host = u.hostname.toLowerCase();
  const m = /^([a-z]{20})\.supabase\.(co|in)$/.exec(host);
  if (!m) throw new BindingError('supabase_url_unrecognised_host');
  return m[1];
}

// ---------------------------------------------------------------------------
// [R4] Which target is this deployment supposed to be?
// ---------------------------------------------------------------------------
export function resolveTargetName(env = process.env) {
  const v = String(env.VERCEL_ENV || '').toLowerCase();
  if (v === 'production') return 'production';
  if (v === 'preview') return 'preview';
  if (v === 'development' || v === '') return 'development';
  throw new BindingError('unknown_deployment_target', v);
}

function required(env, name) {
  const v = env[name];
  if (!v || !String(v).trim()) throw new BindingError('missing_required_config', name);
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// [R12] Success-only cache, bounded, per serverless instance.
// A FAILURE IS NEVER CACHED AS SUCCESS. We cache nothing on the failure path at all, so a
// transient outage cannot be promoted into a durable "verified" state.
// ---------------------------------------------------------------------------
const IDENTITY_TTL_MS = 60_000;
let _verified = null;   // { at:number, key:string, binding:object }

export function _resetBindingCache() { _verified = null; }   // tests only

// ---------------------------------------------------------------------------
// [R1][R2] Assemble the binding. No fallback to any real project, key, provider or origin.
// ---------------------------------------------------------------------------
function assembleBinding(env, targets) {
  const targetName = resolveTargetName(env);
  const target = (targets || TARGETS)[targetName];
  if (!target) throw new BindingError('no_target_definition', targetName);

  const supabaseUrl = required(env, 'SUPABASE_URL');
  const serviceKey = required(env, 'SUPABASE_SERVICE_KEY');
  const siteOrigin = required(env, 'SITE_ORIGIN');
  const actualRef = parseProjectRef(supabaseUrl);

  // Retired projects are refused before anything else, so a stale variable cannot resurrect one.
  if (RETIRED_REFS.has(actualRef)) throw new BindingError('retired_project_ref', actualRef);

  // [R5] expected ref must be configured in reviewed code AND must match.
  if (!target.projectRef) throw new BindingError('target_ref_not_configured', targetName);
  if (actualRef !== target.projectRef) {
    throw new BindingError('project_ref_mismatch', { target: targetName });
  }

  // [R8] Stripe mode is enforced against the deployment target, not trusted.
  const stripeKey = env.STRIPE_SECRET_KEY ? String(env.STRIPE_SECRET_KEY).trim() : null;
  let stripeMode = 'unset';
  if (stripeKey) {
    if (stripeKey.startsWith('sk_live_')) stripeMode = 'live';
    else if (stripeKey.startsWith('sk_test_')) stripeMode = 'test';
    else throw new BindingError('stripe_key_unrecognised');
  }
  if (stripeMode !== 'unset' && stripeMode !== target.stripeMode) {
    // preview must never hold a live key; production must never run on a test key once live
    // payments are enabled. LIVE_PAYMENTS_ENABLED gates the production side explicitly.
    const productionStillOnTest =
      targetName === 'production' && stripeMode === 'test' && env.LIVE_PAYMENTS_ENABLED !== 'true';
    if (!productionStillOnTest) throw new BindingError('stripe_mode_mismatch', { target: targetName, mode: stripeMode });
  }

  // [R9] Email containment. Non-production may only send to a sink/allowlist.
  const emailMode = target.emailMode;
  let emailAllowlist = [];
  if (emailMode === 'sink') {
    const raw = env.EMAIL_ALLOWLIST ? String(env.EMAIL_ALLOWLIST).trim() : '';
    if (!raw) throw new BindingError('email_allowlist_required_for_non_production');
    emailAllowlist = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!emailAllowlist.length) throw new BindingError('email_allowlist_empty');
  } else if (env.REAL_EMAIL_ENABLED !== 'true') {
    // production must opt in explicitly before real recipients are reachable
    throw new BindingError('real_email_not_enabled');
  }

  return {
    targetName,
    projectRef: actualRef,
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    serviceKey,
    publishableKey: env.SUPABASE_ANON_KEY ? String(env.SUPABASE_ANON_KEY).trim() : null,
    siteOrigin,
    stripeKey,
    stripeMode,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    emailMode,
    emailAllowlist,
    expectedDbEnvironment: target.dbEnvironment,
  };
}

// ---------------------------------------------------------------------------
// [R6][R7] Ask the database who it is. This single call also proves the URL/key pair belongs
// together — a key from a different project cannot read this project's identity.
// ---------------------------------------------------------------------------
async function verifyDatabaseIdentity(b, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${b.supabaseUrl}/rest/v1/rpc/get_deployment_identity`, {
      method: 'POST',
      headers: {
        apikey: b.serviceKey,
        Authorization: `Bearer ${b.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (e) {
    throw new BindingError('identity_check_unreachable');
  }

  if (res.status === 401 || res.status === 403) throw new BindingError('credentials_rejected_by_project');
  if (!res.ok) throw new BindingError('identity_check_failed', { status: res.status });

  let rows;
  try { rows = await res.json(); } catch { throw new BindingError('identity_unreadable'); }
  const row = Array.isArray(rows) ? rows[0] : rows;

  // Unprovisioned is a FAILURE, not an unknown-but-fine.
  if (!row || !row.environment || !row.project_ref) throw new BindingError('identity_not_provisioned');

  if (row.environment !== b.expectedDbEnvironment) {
    throw new BindingError('database_environment_mismatch', {
      expected: b.expectedDbEnvironment, actual: row.environment,
    });
  }
  if (row.project_ref !== b.projectRef) {
    throw new BindingError('database_project_ref_mismatch');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public entry point. Every DB-touching route calls this FIRST.
// ---------------------------------------------------------------------------
export async function getBinding(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetch || globalThis.fetch;

  const b = assembleBinding(env, opts.targets);
  const key = `${b.targetName}:${b.projectRef}:${b.stripeMode}:${b.emailMode}`;

  if (_verified && _verified.key === key && (Date.now() - _verified.at) < IDENTITY_TTL_MS) {
    return _verified.binding;
  }

  await verifyDatabaseIdentity(b, fetchImpl);
  _verified = { at: Date.now(), key, binding: b };   // [R12] only successes are cached
  return b;
}

// ---------------------------------------------------------------------------
// [R10] Uniform failure. Generic to the caller, specific in the log.
// ---------------------------------------------------------------------------
export function sendBindingFailure(res, err) {
  const code = err instanceof BindingError ? err.code : 'binding_invalid';
  // [R11] redacted: target labels and codes only. Never a key, URL credential, or full config.
  console.error('BINDING_INVALID', JSON.stringify({
    code,
    detail: err && err.detail && typeof err.detail === 'object' ? err.detail : undefined,
    target: process.env.VERCEL_ENV || null,
    deployment: process.env.VERCEL_DEPLOYMENT_ID || null,
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 10) || null,
  }));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(503).json({ error: 'binding_invalid' });
}

// Convenience wrapper so a route cannot forget the failure path.
export async function withBinding(req, res, handler) {
  let b;
  try { b = await getBinding(); }
  catch (e) { return sendBindingFailure(res, e); }
  return handler(b);
}

// ---------------------------------------------------------------------------
// Shared Supabase access. Routes stop building their own fetch wrappers.
// ---------------------------------------------------------------------------
export function supabase(b) {
  const base = b.supabaseUrl;
  const h = (extra) => ({
    apikey: b.serviceKey,
    Authorization: `Bearer ${b.serviceKey}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  });

  async function rest(path, opts = {}) {
    return fetch(`${base}/rest/v1/${path}`, {
      ...opts,
      headers: h({ Prefer: 'return=representation', ...(opts.headers || {}) }),
    });
  }
  async function json(path, opts) {
    const r = await rest(path, opts);
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
    if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
    return j;
  }
  async function rpc(fn, args) {
    const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: h(), body: JSON.stringify(args || {}),
    });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  }
  const storage = {
    base: `${base}/storage/v1`,
    headers: h,
    publicUrl: (bucket, path) => `${base}/storage/v1/object/public/${bucket}/${path}`,
  };
  return { rest, json, rpc, storage };
}

// ---------------------------------------------------------------------------
// [R11] Redacted diagnostic for api/version.js. No values, ever.
// ---------------------------------------------------------------------------
export function diagnosticSnapshot(b) {
  return {
    target: b.targetName,
    project_ref_fingerprint: b.projectRef ? b.projectRef.slice(0, 4) + '…' : null,
    db_environment_expected: b.expectedDbEnvironment,
    stripe_mode: b.stripeMode,
    email_mode: b.emailMode,
    email_allowlist_count: b.emailAllowlist.length,
    has_publishable_key: !!b.publishableKey,
    has_webhook_secret: !!b.stripeWebhookSecret,
  };
}
