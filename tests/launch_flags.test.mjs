// tests/launch_flags.test.mjs — Gate 0 (G0-C1..C3) effective-state proof.
// Every closed-launch switch must require an EXACT "true", and COI automation must stay off even
// when the legacy COI_ENFORCEMENT_MODE is set to live. Run: node tests/launch_flags.test.mjs
// Gate 0 correction proof: every switch/mode combination Codex listed.
const cases = [];
function run(env, label) {
  for (const k of ['PUBLIC_RETAILER_SIGNUP_ENABLED','COI_AI_VERIFICATION_ENABLED','COI_AUTO_ENFORCEMENT_ENABLED','CHECKOUT_ENABLED','COI_UPLOAD_ENABLED','BRAND_INVITE_ENABLED','COI_ENFORCEMENT_MODE','LAUNCH_MAX_CART']) delete process.env[k];
  Object.assign(process.env, env);
  return import(`../_flags.js?v=${Math.random()}`).then(m => ({ label, snap: m.flagSnapshot() }));
}
const T = [
  [{}, 'all unset'],
  [{ CHECKOUT_ENABLED: '' }, 'checkout empty'],
  [{ CHECKOUT_ENABLED: 'TRU E' }, 'checkout malformed'],
  [{ CHECKOUT_ENABLED: 'false' }, 'checkout false'],
  [{ CHECKOUT_ENABLED: 'true' }, 'checkout exact true'],
  [{ COI_UPLOAD_ENABLED: 'yes' }, 'coi upload "yes"'],
  [{ COI_UPLOAD_ENABLED: 'true' }, 'coi upload exact true'],
  [{ BRAND_INVITE_ENABLED: 'TRUE' }, 'invite "TRUE" (case)'],
  [{ COI_ENFORCEMENT_MODE: 'live' }, 'mode=live, flag unset'],
  [{ COI_AUTO_ENFORCEMENT_ENABLED: 'false', COI_ENFORCEMENT_MODE: 'live' }, 'flag=false, mode=live'],
  [{ COI_AUTO_ENFORCEMENT_ENABLED: 'yes', COI_ENFORCEMENT_MODE: 'live' }, 'flag malformed, mode=live'],
  [{ COI_AUTO_ENFORCEMENT_ENABLED: 'true' }, 'flag=true, mode unset'],
  [{ COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'bogus' }, 'flag=true, mode invalid'],
  [{ COI_AUTO_ENFORCEMENT_ENABLED: 'true', COI_ENFORCEMENT_MODE: 'dry_run' }, 'flag=true, mode=dry_run'],
  [{ LAUNCH_MAX_CART: '10' }, 'cart max 10'],
  [{ LAUNCH_MAX_CART: '999' }, 'cart max out of range'],
];
for (const [env, label] of T) cases.push(await run(env, label));
let fail = 0;
const expect = (c, cond, why) => { if (!cond) { fail++; console.log('  FAIL', c.label, '-', why, JSON.stringify(c.snap)); } else console.log('  ok  ', c.label); };
for (const c of cases) {
  const s = c.snap;
  if (c.label.startsWith('checkout')) expect(c, s.checkoutEnabled === (c.label.includes('exact true')), 'checkout only on exact true');
  if (c.label.startsWith('coi upload')) expect(c, s.coiUploadEnabled === (c.label.includes('exact true')), 'upload only on exact true');
  if (c.label.includes('invite "TRUE"')) expect(c, s.brandInviteEnabled === true, 'case-insensitive true accepted');
  if (c.label.includes('mode=live') || c.label.includes('mode invalid') || c.label.includes('mode unset'))
    expect(c, s.coiEnforcementEffective === (c.label === 'flag=true, mode=dry_run' ? 'dry_run' : 'off'), 'effective must be off');
  if (c.label === 'flag=true, mode=dry_run') expect(c, s.coiEnforcementEffective === 'dry_run', 'dry_run allowed');
  if (c.label === 'cart max 10') expect(c, s.max_cart === 10, 'cart honoured');
  if (c.label === 'cart max out of range') expect(c, s.max_cart === 25, 'out-of-range clamps to default');
  if (c.label === 'all unset') expect(c, s.checkoutEnabled === false && s.coiUploadEnabled === false && s.brandInviteEnabled === false && s.publicRetailerSignup === false && s.coiAiVerification === false && s.coiEnforcementEffective === 'off', 'everything off when unset');
  expect(c, s.connectedCheckout === 'hard_disabled', 'connected labelled hard_disabled');
}
console.log(fail === 0 ? '\nALL FLAG CASES PASS' : `\n${fail} FAILURES`);
process.exit(fail ? 1 : 0);
