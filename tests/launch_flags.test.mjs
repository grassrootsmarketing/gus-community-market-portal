// tests/launch_flags.test.mjs — Gate 0 effective-state proof (G0-C1..C3, G0-v2-1..3).
//
// Run from the repository root:   node tests/launch_flags.test.mjs
// Exit code 0 iff every case passes.
//
// Covers, for EVERY closed-launch switch: unset, empty, "false", malformed, case/whitespace
// variants, and the literal "true". Plus the full COI dual-gate matrix, including the positive case
// (flag true + mode live -> live), which proves the gate is a real control and not a hard-off.

const SWITCHES = [
  ['PUBLIC_RETAILER_SIGNUP_ENABLED', 'publicRetailerSignup'],
  ['COI_AI_VERIFICATION_ENABLED', 'coiAiVerification'],
  ['CHECKOUT_ENABLED', 'checkoutEnabled'],
  ['COI_UPLOAD_ENABLED', 'coiUploadEnabled'],
  ['BRAND_INVITE_ENABLED', 'brandInviteEnabled'],
  ['COI_AUTO_ENFORCEMENT_ENABLED', 'coiAutoEnforcementFlag'],
];
const ALL_ENV = [...SWITCHES.map(([e]) => e), 'COI_ENFORCEMENT_MODE', 'LAUNCH_MAX_CART'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, detail === undefined ? '' : `-> ${JSON.stringify(detail)}`); }
}

// Fresh module instance per case: flags are read once at module load.
async function snapshot(env) {
  for (const k of ALL_ENV) delete process.env[k];
  Object.assign(process.env, env);
  const m = await import(`../api/_flags.js?case=${Math.random()}`);
  return m.flagSnapshot();
}

console.log('\n--- per-switch matrix: only the literal "true" may enable ---');
for (const [envVar, field] of SWITCHES) {
  for (const [label, value, expected] of [
    ['unset', undefined, false],
    ['empty', '', false],
    ['false', 'false', false],
    ['malformed', 'tru e', false],
    ['uppercase TRUE', 'TRUE', false],
    ['padded " true "', ' true ', false],
    ['mixed case True', 'True', false],
    ['literal true', 'true', true],
  ]) {
    const env = value === undefined ? {} : { [envVar]: value };
    const snap = await snapshot(env);
    check(`${envVar} ${label} -> ${expected}`, snap[field] === expected, snap[field]);
  }
}

console.log('\n--- COI dual gate: effective mode ---');
for (const [label, env, expected] of [
  ['flag unset + mode live', { COI_ENFORCEMENT_MODE: 'live' }, 'off'],
  ['flag false + mode live', { COI_AUTO_ENFORCEMENT_ENABLED: 'false', COI_ENFORCEMENT_MODE: 'live' }, 'off'],
  ['flag malformed + mode live', { COI_AUTO_ENFORCEMENT_ENABLED: 'yes', COI_ENFORCEMENT_MODE: 'live' }, 'off'],
  ['flag TRUE uppercase + mode live', { COI_AUTO_ENFORCEMENT_ENABLED: 'TRUE', COI_ENFORCEMENT_MODE: 'live' }, 'off'],
  ['flag true + mode unset', { COI_AUTO_ENFORCEMENT_ENABLED: 'true' }, 'off'],
  ['flag true + mode invalid', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'bogus' }, 'off'],
  ['flag true + mode off', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'off' }, 'off'],
  ['flag true + mode dry_run', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'dry_run' }, 'dry_run'],
  ['flag true + mode warn_only', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'warn_only' }, 'warn_only'],
  ['flag true + mode live', { COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'live' }, 'live'],
]) {
  const snap = await snapshot(env);
  check(`${label} -> ${expected}`, snap.coiEnforcementEffective === expected, snap.coiEnforcementEffective);
}

console.log('\n--- cart maximum + non-env state ---');
{
  let s = await snapshot({ LAUNCH_MAX_CART: '10' });
  check('cart max 10 honoured', s.max_cart === 10, s.max_cart);
  s = await snapshot({ LAUNCH_MAX_CART: '999' });
  check('cart max out of range clamps to 25', s.max_cart === 25, s.max_cart);
  s = await snapshot({ LAUNCH_MAX_CART: 'abc' });
  check('cart max malformed clamps to 25', s.max_cart === 25, s.max_cart);
  s = await snapshot({});
  check('connected checkout reported hard_disabled', s.connectedCheckout === 'hard_disabled', s.connectedCheckout);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
