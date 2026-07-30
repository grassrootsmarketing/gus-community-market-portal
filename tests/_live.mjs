// tests/_live.mjs — harness for VALID-BINDING tests against a real database.
//
// Codex Step 4. The mocked suites prove the guards refuse an invalid binding; they cannot prove
// a flow works. These run against the rebuilt staging project.
//
// Credentials come from the environment ONLY. Nothing is hardcoded, so this file is safe to
// commit and safe to include in a patch.
export const SB_URL = process.env.SB_URL;
export const SB_KEY = process.env.SB_KEY;
export const SB_REF = process.env.SB_REF;
if (!SB_URL || !SB_KEY || !SB_REF) {
  console.error('SB_URL, SB_KEY and SB_REF are required. Refusing to run rather than pass vacuously.');
  process.exit(2);
}

// Guard: never let this suite point at production or the retired projects, whatever the env says.
const FORBIDDEN = new Set(['ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn']);
if (FORBIDDEN.has(SB_REF)) { console.error(`REFUSING: ${SB_REF} is production or a retired project.`); process.exit(2); }
if (!SB_URL.includes(SB_REF)) { console.error('REFUSING: SB_URL does not match SB_REF.'); process.exit(2); }

const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };

export async function rest(path, opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...H, Prefer: opts.prefer || 'return=representation', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { ok: r.ok, status: r.status, body: json };
}

export async function rpc(fn, args = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
  return { ok: r.ok, status: r.status, body: json };
}

export async function sql(statement) {
  // No arbitrary-SQL endpoint exists by design, so multi-step setup goes through PostgREST.
  throw new Error('no raw SQL endpoint: use rest()/rpc()');
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
export const state = { pass: 0, fail: 0, fails: [] };
export function ok(name, cond, extra = '') {
  if (cond) { state.pass++; console.log(`  ok   ${name}`); }
  else { state.fail++; state.fails.push(`${name} ${extra}`); console.log(`  FAIL ${name} ${extra}`); }
}
export function summary(label) {
  console.log(`\n${label}: ${state.pass} passed, ${state.fail} failed`);
  if (state.fail) { console.log('FAILURES:'); state.fails.forEach(f => console.log('  x ' + f)); }
  return state.fail === 0;
}

export const uniq = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
