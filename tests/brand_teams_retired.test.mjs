// tests/brand_teams_retired.test.mjs (David, 2026-10-17): one email per brand. Brand teams are gone.
//   1. the brand dashboard has no Team tab, no invite modal, no team handlers, and the Account tab states the rule
//   2. the brand account API answers 410 brand_teams_retired to all four team actions (route harness, no database)
//   3. the sign-up page, the booking modal and the welcome email carry the one-brand statement
//   4. the signed-in booking modal says "Booking as <brand>"
// Retailer teams (admin-auth) are untouched and are covered by their own suites.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

const dash = readFileSync('brand/dashboard/index.html', 'utf8');
ok('1a. no Team tab in the whitelist', !/'team'/.test(dash));
ok('1b. no invite modal, no team renderer, no team handlers', !/teamInviteModal|renderTeam|inviteTeammate|removeTeamMember|sendTeamInvite/.test(dash));
ok('1c. no team API calls from the dashboard', !/team-list|team-invite|team-remove|team-update-role/.test(dash));
ok('1d. Account tab states the one-brand rule and points to the designated booker (0097)', /One account per brand, created by the brand/.test(dash) && /designate them as your booker/.test(dash));

const api = readFileSync('api/brand-account.js', 'utf8');
ok('2a. the four team actions share one 410 branch', /action === 'team-list' \|\| action === 'team-invite' \|\| action === 'team-remove' \|\| action === 'team-update-role'/.test(api) && /410, \{ error: 'brand_teams_retired'/.test(api));
ok('2b. no team insert or roster read remains', !/brand_members\?brand_id=eq\.\$\{v\.brand_id\}&select=\*/.test(api) && !/invited_by_email: v\.email/.test(api));
ok('2c. welcome email carries the statement (owner sign-in; designate a booker for anyone else)', /its owner sign-in/.test(api) && /designate them as your booker/.test(api));

const signup = readFileSync('brand/index.html', 'utf8');
ok('3a. sign-up page says one account per brand, created by the brand', /One account per brand, created by the brand/.test(signup));
const booking = readFileSync('r/gus/index.html', 'utf8');
ok('3b. booking modal (new account) says one account per brand', /One account per brand, created by the brand\.<\/p>/.test(booking));
ok('4. signed-in booking modal says Booking as <brand>', /'Booking as ' \+ \(bp\.company_name \|\| bp\.email\)/.test(booking) && /under its insurance and agreements/.test(booking));

// live route check through the project's route harness (no database: the 410 fires before any read). The harness
// needs the SB_* variables from demohub.env; without them (plain npm test) the static checks above stand alone.
if (!process.env.SB_URL) console.log('  (route check skipped: run through run-test.sh for it)');
else {
  const { callRoute, req } = await import('./_route.mjs');
  for (const action of ['team-list', 'team-invite', 'team-remove', 'team-update-role']) {
    const r = await callRoute('brand-account.js', req({ method: action === 'team-list' ? 'GET' : 'POST', query: { action }, body: { action, email: 'x@y.test' } }));
    ok(`2d. ${action} answers 410 brand_teams_retired (got ${r.statusCode})`, r.statusCode === 410 && r.body && r.body.error === 'brand_teams_retired', JSON.stringify(r.body).slice(0, 160));
  }
}

ok('5. no em dashes in the touched files', ![dash, api, signup, booking].some(s => /, /.test(s)));
console.log(`\nbrand teams retired: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
