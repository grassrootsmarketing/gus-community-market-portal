// tests/multi_brand_concurrency.test.mjs (0122, 2026-11-19; Codex multi-brand review, findings 3 and 4).
// Real concurrent transactions on the TEST database (demohub-rebuild-check) through two or more direct connections.
// Nothing here is string matching: one transaction is held open, a second one is started, and the test observes
// whether the second waits and what it answers after the first commits.
//
//   K1  switch off: the SAME address granted by two DIFFERENT brands. The second grant must wait for the first and then
//       be refused (one identity per email). Mixed case and padded addresses are the same address.
//   K2  the same, free running, many brands at once, repeated: never more than one live identity.
//   K3  switch off: two addresses granted by the SAME brand at once: one booker per brand.
//   K4  grant versus sign-up for the same address, in both orders: never a brand owner who is also someone's booker.
//   K5  the pre-0121 build's direct insert (no function): same rules, same locks, including against a function grant.
//       A direct insert can never create a Full access row.
//   K6  switch on: the same address is granted by several brands at once and all succeed; the same brand twice gives
//       one row; the per-brand cap holds under concurrency.
//   K7  an access request answered twice at once (approve and decline): exactly one decision.
//
// Run: SB_DB_URL = the test project's database URL (refused for anything else).
import pg from 'pg';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url) || !/\/postgres(\?|$)/.test(url)) { console.error('REFUSING: SB_DB_URL is not the public database of demohub-rebuild-check'); process.exit(2); }
let pass = 0, fail = 0; const fails = [];
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + d); console.log('  FAIL ' + n + ' ' + d); } };
const conn = async () => { const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; };
const admin = await conn();
{
  const id = (await admin.query('select environment, project_ref from get_deployment_identity()')).rows[0];
  if (!id || id.environment === 'production' || id.project_ref !== 'tileejdviuvijumjeplv') { console.error('REFUSING: identity', id); process.exit(2); }
}
const tag = 'cc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const brandIds = [];
const mkBrand = async (n) => { const email = `${tag}-owner${n}@fixture.test`; const r = await admin.query('insert into brands (email, company_name, is_verified) values ($1, $2, true) returning id', [email, 'Concurrency Fixture ' + n]); brandIds.push(r.rows[0].id); return { id: r.rows[0].id, email }; };
const grant = (c, brand, email, role, multi) => c.query('select brand_access_grant($1, $2, null, $3, $4, $5) as r', [brand.id, email, role, brand.email, multi]).then(x => x.rows[0].r);
const live = async (email) => (await admin.query("select brand_id, role, status from brand_members where lower(email) = lower(btrim($1)) and status in ('pending','accepted') and role <> 'owner'", [email])).rows;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Start q on connection b while connection a holds an open transaction; report whether b was still waiting after a
// pause, then commit a and return b's outcome.
const raceHeld = async (a, b, startB) => {
  let settled = false, value = null, error = null;
  const p = startB().then(v => { settled = true; value = v; }, e => { settled = true; error = e; });
  await sleep(700);
  const waited = !settled;
  await a.query('COMMIT');
  await p;
  return { waited, value, error };
};
const B = []; for (let i = 0; i < 12; i++) B.push(await mkBrand(i));
const c1 = await conn(), c2 = await conn();
const pool = []; for (let i = 0; i < 8; i++) pool.push(await conn());

try {
  console.log('\n:: K1 switch off, same address, two different brands ::');
  {
    const e = `${tag}-k1@fixture.test`;
    await c1.query('BEGIN');
    const first = await grant(c1, B[0], e, 'booker', false);
    const r = await raceHeld(c1, c2, () => grant(c2, B[1], '  ' + e.toUpperCase() + ' ', 'booker', false));
    const rows = await live(e);
    ok('K1a the first grant succeeds', first.outcome === 'ok', JSON.stringify(first));
    ok('K1b the second brand\'s grant WAITS for the first transaction (it cannot read past it)', r.waited === true, 'waited=' + r.waited + ' ' + JSON.stringify(r.value));
    ok('K1c after the first commits, the second is refused: one identity per email (case and padding ignored)', r.value && r.value.outcome === 'email_in_use', JSON.stringify(r.value) + (r.error ? ' ' + r.error.message : ''));
    ok('K1d exactly one live identity exists for the address', rows.length === 1 && rows[0].brand_id === B[0].id, JSON.stringify(rows));
  }

  console.log('\n:: K2 the same, free running, eight brands at once, six rounds ::');
  {
    let worst = 0, oks = 0;
    for (let round = 0; round < 6; round++) {
      const e = `${tag}-k2-${round}@fixture.test`;
      const outs = await Promise.all(pool.map((c, i) => grant(c, B[i], (i % 2 ? e.toUpperCase() : ' ' + e), 'booker', false).catch(err => ({ outcome: 'error:' + err.message }))));
      const rows = await live(e);
      worst = Math.max(worst, rows.length); oks += outs.filter(o => o.outcome === 'ok').length;
      for (const row of rows) await admin.query("update brand_members set status = 'revoked', revoked_at = now() where brand_id = $1 and lower(email) = $2 and role <> 'owner'", [row.brand_id, e]);
    }
    ok('K2 never more than one live identity per address, and exactly one grant wins each round', worst === 1 && oks === 6, 'worst=' + worst + ' oks=' + oks);
  }

  console.log('\n:: K3 switch off, same brand, two addresses at once ::');
  {
    const outs = await Promise.all([grant(pool[0], B[8], `${tag}-k3a@fixture.test`, 'booker', false), grant(pool[1], B[8], `${tag}-k3b@fixture.test`, 'booker', false)]);
    const n = (await admin.query("select count(*)::int n from brand_members where brand_id = $1 and role <> 'owner' and status in ('pending','accepted')", [B[8].id])).rows[0].n;
    ok('K3 one booker per brand: one grant wins, the other is told a booker is already designated', n === 1 && outs.filter(o => o.outcome === 'ok').length === 1 && outs.some(o => o.outcome === 'booker_already_designated'), JSON.stringify(outs.map(o => o.outcome)));
  }

  console.log('\n:: K4 grant versus sign-up for the same address ::');
  {
    const redeem = (c, email, code) => c.query('select redeem_brand_signup($1, $2, $3, 30, 6) as r', [email, code, 'sess-' + tag + Math.random().toString(36).slice(2)]).then(x => x.rows[0].r);
    const challenge = (email, code) => admin.query("insert into email_verifications (email, purpose, code_hash, payload, expires_at) values ($1, 'brand_signup', $2, '{}'::jsonb, now() + interval '30 minutes')", [email, code]);
    // sign-up first (held), then the grant
    const e1 = `${tag}-k4a@fixture.test`;
    await challenge(e1, 'h-' + tag + 'a');
    await c1.query('BEGIN');
    const su = await redeem(c1, e1, 'h-' + tag + 'a');
    const r1 = await raceHeld(c1, c2, () => grant(c2, B[9], e1.toUpperCase(), 'booker', false));
    const made = (await admin.query('select id from brands where lower(email) = $1', [e1])).rows;
    for (const m of made) brandIds.push(m.id);
    ok('K4a sign-up creates the brand; the grant for the same address waits, then is refused (the address owns a brand)', su.outcome === 'ok' && su.created === true && r1.waited === true && r1.value && r1.value.outcome === 'email_in_use' && (await live(e1)).length === 0, 'waited=' + r1.waited + ' ' + JSON.stringify(r1.value));
    // grant first (held), then the sign-up
    const e2 = `${tag}-k4b@fixture.test`;
    await challenge(e2, 'h-' + tag + 'b');
    await c1.query('BEGIN');
    const g = await grant(c1, B[9], e2, 'booker', false);
    const r2 = await raceHeld(c1, c2, () => redeem(c2, ' ' + e2.toUpperCase(), 'h-' + tag + 'b'));
    const none = (await admin.query('select count(*)::int n from brands where lower(email) = $1', [e2])).rows[0].n;
    ok('K4b the grant is recorded; the sign-up for the same address waits, then answers invite_pending and creates NO brand', g.outcome === 'ok' && r2.waited === true && r2.value && r2.value.outcome === 'invite_pending' && none === 0, 'waited=' + r2.waited + ' ' + JSON.stringify(r2.value) + ' brands=' + none);
  }

  console.log('\n:: K5 the earlier build\'s direct insert (no function) ::');
  {
    const direct = (c, brand, email, role = 'booker') => c.query("insert into brand_members (brand_id, email, role, status, invited_by_email) values ($1, $2, $3, 'pending', $4) returning id", [brand.id, email, role, brand.email]);
    const e = `${tag}-k5@fixture.test`;
    await c1.query('BEGIN');
    await direct(c1, B[10], e);
    const r = await raceHeld(c1, c2, () => direct(c2, B[11], e.toUpperCase()));
    ok('K5a two direct inserts of the same address by two brands: the second waits, then is refused with a unique violation', r.waited === true && r.error && r.error.code === '23505' && (await live(e)).length === 1, 'waited=' + r.waited + ' ' + (r.error ? r.error.code + ' ' + r.error.message : JSON.stringify(r.value && r.value.rows)));
    const e2 = `${tag}-k5b@fixture.test`;
    await c1.query('BEGIN');
    await direct(c1, B[11], e2);
    const fresh = await mkBrand('k5b');
    const r2 = await raceHeld(c1, c2, () => grant(c2, fresh, e2, 'booker', false));
    ok('K5b a direct insert and a function grant for the same address serialize too', r2.waited === true && r2.value && r2.value.outcome === 'email_in_use' && (await live(e2)).length === 1, 'waited=' + r2.waited + ' ' + JSON.stringify(r2.value));
    const second = await direct(admin, B[10], `${tag}-k5c@fixture.test`).then(() => null, err => err);
    ok('K5c a direct insert of a second booker on a brand is refused', second && second.code === '23505', second ? second.code + ' ' + second.message : 'inserted');
    const owner = await direct(admin, B[5], B[4].email).then(() => null, err => err);
    ok('K5d a direct insert for an address that owns a brand is refused', owner && owner.code === '23505', owner ? owner.code : 'inserted');
    const mgr = await direct(admin, B[5], `${tag}-k5e@fixture.test`, 'manager').then(() => null, err => err);
    ok('K5e a direct insert can never create a Full access row', mgr && mgr.code === '23514' && /direct_member_write_refused/.test(mgr.message), mgr ? mgr.code + ' ' + mgr.message : 'inserted');
  }

  console.log('\n:: K6 switch on: several brands for one address ::');
  {
    const e = `${tag}-k6@fixture.test`;
    const outs = await Promise.all(pool.slice(0, 5).map((c, i) => grant(c, B[i + 2], i % 2 ? e.toUpperCase() : e, i % 2 ? 'manager' : 'booker', true)));
    const rows = await live(e);
    ok('K6a five brands grant the same address at once and all five succeed', outs.every(o => o.outcome === 'ok') && rows.length === 5 && new Set(rows.map(r => r.brand_id)).size === 5, JSON.stringify(outs.map(o => o.outcome)));
    const twice = await Promise.all([grant(pool[0], B[7], e, 'booker', true), grant(pool[1], B[7], e, 'manager', true)]);
    const n = (await admin.query("select count(*)::int n from brand_members where brand_id = $1 and lower(email) = $2 and status in ('pending','accepted')", [B[7].id, e])).rows[0].n;
    ok('K6b the same brand granting the same address twice at once gives one row', n === 1 && twice.filter(o => o.outcome === 'ok').length === 1 && twice.some(o => o.outcome === 'already_has_access'), JSON.stringify(twice.map(o => o.outcome)));
    // the cap: fill a brand to 19, then two more at once
    const capBrand = await mkBrand('cap');
    for (let i = 0; i < 19; i++) await grant(admin, capBrand, `${tag}-cap${i}@fixture.test`, 'booker', true);
    const last = await Promise.all([grant(pool[0], capBrand, `${tag}-capx@fixture.test`, 'booker', true), grant(pool[1], capBrand, `${tag}-capy@fixture.test`, 'booker', true)]);
    const total = (await admin.query("select count(*)::int n from brand_members where brand_id = $1 and role <> 'owner' and status in ('pending','accepted')", [capBrand.id])).rows[0].n;
    ok('K6c the per-brand cap of 20 holds when two grants arrive together at 19', total === 20 && last.filter(o => o.outcome === 'ok').length === 1 && last.some(o => o.outcome === 'too_many_people'), 'total=' + total + ' ' + JSON.stringify(last.map(o => o.outcome)));
  }

  console.log('\n:: K7 an access request answered twice at once ::');
  {
    let both = 0, members = 0, rounds = 5;
    for (let i = 0; i < rounds; i++) {
      const e = `${tag}-k7-${i}@fixture.test`, th = 'th-' + tag + '-' + i;
      const cr = (await admin.query("select brand_access_request_create($1, 'K Seven', null, $2, 'manager', $3, 24, '2026-06-29', null) as r", [e, B[1].email, th])).rows[0].r;
      const decide = (c, d) => c.query('select brand_access_request_decide($1, null, null, $2, null, null) as r', [th, d]).then(x => x.rows[0].r);
      const outs = await Promise.all([decide(pool[0], 'approve'), decide(pool[1], 'decline')]);
      const wins = outs.filter(o => o.outcome === 'ok');
      const row = (await admin.query('select status from brand_access_requests where id = $1', [cr.request_id])).rows[0];
      const mem = await live(e);
      if (wins.length === 1 && outs.some(o => o.outcome === 'already_decided') && ((row.status === 'approved') === (mem.length === 1))) both++;
      members += mem.length;
      await admin.query("update brand_members set status = 'revoked', revoked_at = now() where lower(email) = $1 and role <> 'owner'", [e]);
    }
    ok('K7 approve and decline arriving together give exactly one decision every time, and access exists only if approve won', both === rounds, both + '/' + rounds + ' members=' + members);
  }
} catch (e) {
  ok('the suite ran without an unexpected error', false, (e && e.stack) || String(e));
  for (const c of [c1, c2]) { try { await c.query('ROLLBACK'); } catch (_) {} }
} finally {
  const ids = brandIds;
  await admin.query('delete from brand_access_requests where brand_id = any($1::uuid[])', [ids]);
  await admin.query('delete from brand_booker_invites where brand_id = any($1::uuid[])', [ids]);
  await admin.query('delete from brand_account_sessions where brand_id = any($1::uuid[])', [ids]);
  await admin.query('delete from brand_members where brand_id = any($1::uuid[])', [ids]);
  await admin.query("delete from email_verifications where email like $1", [tag + '-%@fixture.test']);
  await admin.query('delete from brands where id = any($1::uuid[])', [ids]);
  for (const c of [admin, c1, c2, ...pool]) await c.end().catch(() => {});
}
console.log(`\nmulti-brand concurrency (0122): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f.slice(0, 400))); process.exit(1); }
