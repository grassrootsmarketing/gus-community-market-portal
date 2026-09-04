// tests/venues_bulk_import.test.mjs -- Codex FC-03: /api/venues-bulk-import capacity validation is
// STRICT and FAILS CLOSED, proven through the real exported handler (tests/_route.mjs) against the
// test database.
//
// The old route coerced capacity with Math.max(1, parseInt(v, 10) || 1) -- '0', '-1', 'abc' became 1
// and '2.7' became 2 -- and its tier precheck logged a lookup failure and PROCEEDED. This file locks:
//   * capacity column absent / cell blank -> 1; '1','2','7' -> stored exactly
//   * '0','-1','2.7','1.0','1e2','+3','abc','2147483648' -> 400 invalid_rows naming the row, ZERO inserts
//   * a multi-row file with ONE bad cell -> the whole request is refused, ZERO inserts
//   * retailer / venue-count lookup fault -> 503 entitlement_unavailable, ZERO inserts
//   * solo over-limit -> 402 plan_limit_reached before any write
//   * enforce_venue_limit() refusal mid-import -> 409 venue_limit_reached, ok:false, imported count accurate
//   * viewer / manager -> 403; owner / admin -> allowed
//   * cross-origin -> 403 cross_origin_denied with NO Supabase call at all
// Fixtures are torn down in FK-safe order.
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ORIGIN } from './_route.mjs';

const SB = process.env.SB_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function db(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text: t };
}
const parse = (b) => { if (typeof b === 'string') { try { return JSON.parse(b); } catch (_) { return b; } } return b; };
const one = (r) => { const b = parse(r && r.body); return Array.isArray(b) ? b[0] : b; };
const bin = []; // [table, id]
const track = (t, id) => { if (id) bin.push([t, id]); return id; };

const spy = installSpy();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const mkRetailer = async (slug, name, tier, status = 'active') => track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name, billing_email: `${slug}@fixture.test`, billing_tier: tier, billing_status: status, platform_keeps_all: true }) })).id);
const mkMember = async (rid, email, role) => track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, email, email_normalized: email, name: role + ' fixture', role }) })).id);
async function mintCookie(rid, email) {
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: rid }) }));
  const v = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  if (v.statusCode !== 200) throw new Error('verify failed for ' + email + ': ' + v.statusCode + ' ' + JSON.stringify(v.body));
  return v.cookie('dh_retailer_session');
}
const venues = async (rid) => { const r = await db(`venues?retailer_id=eq.${rid}&select=id,name,max_demos_per_slot&order=created_at.asc`); return Array.isArray(r.body) ? r.body : []; };
const venueCount = async (rid) => (await venues(rid)).length;
const clearVenues = async (rid) => { await db(`venues?retailer_id=eq.${rid}`, { method: 'DELETE' }); };

// The route reads multipart/form-data off the request STREAM (bodyParser is off), exactly as the
// browser sends it: FormData with a single "csv" file field.
function multipart(csv, filename = 'import.csv') {
  const B = '----dhBoundary' + Math.random().toString(36).slice(2);
  const body = `--${B}\r\nContent-Disposition: form-data; name="csv"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${B}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${B}` };
}
async function importCsv(cookie, csv, { csrf = true, origin = ORIGIN, headers = {} } = {}) {
  const { body, contentType } = multipart(csv);
  const h = {
    'content-type': contentType,
    origin,
    ...(csrf ? { 'sec-fetch-site': 'same-origin' } : {}),
    ...(cookie ? { cookie: `dh_retailer_session=${encodeURIComponent(cookie)}` } : {}),
    ...headers,
  };
  const r = await callRoute('venues-bulk-import.js', rawReq(body, { headers: h }));
  return { statusCode: r.statusCode, body: parse(r.body) };
}
const csvWithCapacity = (rows) => 'name,address,capacity\n' + rows.map(([n, c]) => `${n},1 Import St,${c}`).join('\n') + '\n';

const slugP = uniq('bulk-pro'), slugS = uniq('bulk-solo'), slugL = uniq('bulk-legacy');
const P = await mkRetailer(slugP, 'Bulk Pro', 'pro');            // pro: precheck limit 0 (skipped), trigger 999
const S = await mkRetailer(slugS, 'Bulk Solo', 'solo');          // solo: precheck limit 1, trigger 1
const L = await mkRetailer(slugL, 'Bulk Legacy', 'starter');     // legacy starter: precheck SKIPPED (0), trigger treats as solo = 1
const ownerP = `owner-${slugP}@fixture.test`, adminP = `admin-${slugP}@fixture.test`, managerP = `manager-${slugP}@fixture.test`, viewerP = `viewer-${slugP}@fixture.test`;
const ownerS = `owner-${slugS}@fixture.test`, ownerL = `owner-${slugL}@fixture.test`;
await mkMember(P, ownerP, 'owner'); await mkMember(P, adminP, 'admin'); await mkMember(P, managerP, 'manager'); await mkMember(P, viewerP, 'viewer');
await mkMember(S, ownerS, 'owner'); await mkMember(L, ownerL, 'owner');
const ckOwnerP = await mintCookie(P, ownerP), ckAdminP = await mintCookie(P, adminP), ckManagerP = await mintCookie(P, managerP), ckViewerP = await mintCookie(P, viewerP);
const ckOwnerS = await mintCookie(S, ownerS), ckOwnerL = await mintCookie(L, ownerL);

try {
  // =========================================================================
  console.log('\n-- 1: defaults -- capacity column absent or cell blank -> 1 --');
  // =========================================================================
  {
    const r = await importCsv(ckOwnerP, 'name,address\nNo Cap Column,1 Import St\n');
    ok('1a no capacity column: 200 ok:true imported 1', r.statusCode === 200 && r.body && r.body.ok === true && r.body.imported === 1, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const v = (await venues(P)).find(x => x.name === 'No Cap Column');
    ok('1a stored max_demos_per_slot is 1', !!v && v.max_demos_per_slot === 1, JSON.stringify(v));
    await clearVenues(P);
  }
  {
    const r = await importCsv(ckOwnerP, csvWithCapacity([['Blank Cap', '']]));
    ok('1b blank capacity cell: 200 imported 1', r.statusCode === 200 && r.body && r.body.ok === true && r.body.imported === 1, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const v = (await venues(P)).find(x => x.name === 'Blank Cap');
    ok('1b blank cell stored as 1', !!v && v.max_demos_per_slot === 1, JSON.stringify(v));
    await clearVenues(P);
  }
  {
    const r = await importCsv(ckOwnerP, csvWithCapacity([['Cap One', '1'], ['Cap Two', '2'], ['Cap Seven', ' 7 ']]));
    ok('1c "1","2","7": 200 imported 3', r.statusCode === 200 && r.body && r.body.ok === true && r.body.imported === 3 && r.body.total === 3, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const vs = await venues(P);
    const got = Object.fromEntries(vs.map(v => [v.name, v.max_demos_per_slot]));
    ok('1c exact values stored (1, 2, 7 -- "7" was padded with spaces and trimmed)', got['Cap One'] === 1 && got['Cap Two'] === 2 && got['Cap Seven'] === 7, JSON.stringify(got));
    ok('1c success response keeps the client contract (parse_errors/insert_errors arrays empty)', Array.isArray(r.body.parse_errors) && r.body.parse_errors.length === 0 && Array.isArray(r.body.insert_errors) && r.body.insert_errors.length === 0);
    await clearVenues(P);
  }

  // =========================================================================
  console.log('\n-- 2: strict parser -- every rejected literal is a 400 with ZERO inserts --');
  // =========================================================================
  // １ is FULLWIDTH DIGIT ONE: a Unicode-aware \d would match it; [0-9] must not.
  for (const bad of ['0', '-1', '2.7', '1.0', '1e2', '+3', 'abc', '2147483648', 'NaN', '00', '0x10', '１']) {
    const before = await venueCount(P);
    const r = await importCsv(ckOwnerP, csvWithCapacity([[`Bad ${bad}`, bad]]));
    const e = r.body && Array.isArray(r.body.errors) ? r.body.errors[0] : null;
    ok(`2 ${JSON.stringify(bad)} -> 400 invalid_rows`, r.statusCode === 400 && r.body && r.body.ok === false && r.body.error === 'invalid_rows' && r.body.imported === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok(`2 ${JSON.stringify(bad)} error names data row 1 / field max_demos_per_slot with a message`, !!e && e.row === 1 && e.field === 'max_demos_per_slot' && typeof e.message === 'string' && e.message.length > 0, JSON.stringify(e));
    ok(`2 ${JSON.stringify(bad)} inserted nothing`, (await venueCount(P)) === before, `${before} -> ${await venueCount(P)}`);
  }
  {
    const r = await importCsv(ckOwnerP, csvWithCapacity([['Max Int', '2147483647']]));
    ok('2 boundary: 2147483647 (PostgreSQL integer max) is accepted', r.statusCode === 200 && r.body.imported === 1, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const v = (await venues(P)).find(x => x.name === 'Max Int');
    ok('2 boundary: stored exactly 2147483647', !!v && v.max_demos_per_slot === 2147483647, JSON.stringify(v));
    await clearVenues(P);
  }

  // =========================================================================
  console.log('\n-- 3: one bad cell rejects the WHOLE file --');
  // =========================================================================
  {
    const before = await venueCount(P);
    const r = await importCsv(ckOwnerP, csvWithCapacity([['Good A', '2'], ['Bad B', '2.7'], ['Good C', '3']]));
    ok('3 multi-row file with one bad capacity -> 400 invalid_rows, imported 0', r.statusCode === 400 && r.body && r.body.ok === false && r.body.error === 'invalid_rows' && r.body.imported === 0 && r.body.total === 3, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const rows = (r.body && r.body.errors || []).map(e => e.row);
    ok('3 exactly the bad row (data row 2) is named', rows.length === 1 && rows[0] === 2, JSON.stringify(r.body && r.body.errors));
    ok('3 ZERO venues inserted (not "Good A" either)', (await venueCount(P)) === before, `${before} -> ${await venueCount(P)}`);
  }
  {
    // A row missing its name is also a whole-file refusal now -- no partial import of the other rows.
    const before = await venueCount(P);
    const r = await importCsv(ckOwnerP, 'name,address,capacity\nGood A,1 St,2\n,2 St,3\n');
    ok('3 missing name is a whole-file 400 invalid_rows (field name, data row 2)', r.statusCode === 400 && r.body.error === 'invalid_rows' && r.body.errors.some(e => e.row === 2 && e.field === 'name'), `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('3 missing-name file inserted nothing', (await venueCount(P)) === before);
  }

  // =========================================================================
  console.log('\n-- 4: entitlement precheck cannot be read -> 503, ZERO inserts --');
  // =========================================================================
  {
    const before = await venueCount(P);
    spy.faults.push({ url: `retailers?id=eq.${P}&select=billing_tier`, method: 'GET', once: true, status: 500, message: 'injected_retailer_fault' });
    const r = await importCsv(ckOwnerP, csvWithCapacity([['Fault Row', '2']]));
    ok('4a retailer tier lookup fault -> 503 entitlement_unavailable', r.statusCode === 503 && r.body && r.body.ok === false && r.body.error === 'entitlement_unavailable', `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('4a ZERO inserts after the fault', (await venueCount(P)) === before, `${before} -> ${await venueCount(P)}`);
    ok('4a the fault was consumed (route actually performed the lookup)', spy.faults.length === 0, JSON.stringify(spy.faults));
    spy.faults.length = 0;
  }
  {
    const before = await venueCount(S);
    spy.faults.push({ url: `venues?retailer_id=eq.${S}&select=id`, method: 'GET', once: true, status: 500, message: 'injected_count_fault' });
    const r = await importCsv(ckOwnerS, csvWithCapacity([['Solo Fault', '1']]));
    ok('4b venue-count lookup fault (solo precheck) -> 503 entitlement_unavailable', r.statusCode === 503 && r.body && r.body.error === 'entitlement_unavailable', `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('4b ZERO inserts after the count fault', (await venueCount(S)) === before);
    spy.faults.length = 0;
  }

  // =========================================================================
  console.log('\n-- 5: plan limits -- friendly 402 precheck, and the authoritative trigger --');
  // =========================================================================
  {
    const before = await venueCount(S);
    const r = await importCsv(ckOwnerS, csvWithCapacity([['Solo 1', '1'], ['Solo 2', '1']]));
    ok('5a solo importing 2 rows -> 402 plan_limit_reached BEFORE any write', r.statusCode === 402 && r.body && r.body.ok === false && r.body.error === 'plan_limit_reached' && r.body.imported === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('5a solo: ZERO inserts', (await venueCount(S)) === before);
    const r1 = await importCsv(ckOwnerS, csvWithCapacity([['Solo Only', '4']]));
    ok('5a solo importing exactly 1 row is allowed', r1.statusCode === 200 && r1.body.imported === 1, `${r1.statusCode} ${JSON.stringify(r1.body)}`);
    ok('5a solo stored capacity 4 exactly', ((await venues(S))[0] || {}).max_demos_per_slot === 4);
  }
  {
    // Legacy 'starter' tier: TIER_LOCATION_LIMITS maps it to 0 so the JS precheck is skipped, but
    // enforce_venue_limit() treats every non-pro/enterprise tier as Solo (limit 1). The trigger --
    // not the precheck -- refuses the second insert; the route must surface that as non-2xx with an
    // accurate imported count, never ok:true.
    const before = await venueCount(L);
    ok('5b legacy fixture starts with no venues', before === 0, String(before));
    const r = await importCsv(ckOwnerL, csvWithCapacity([['Legacy 1', '2'], ['Legacy 2', '3'], ['Legacy 3', '1']]));
    ok('5b trigger refusal -> 409 venue_limit_reached', r.statusCode === 409 && r.body && r.body.ok === false && r.body.error === 'venue_limit_reached', `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('5b imported count is ACCURATE (1 of 3), failed 2', r.body && r.body.imported === 1 && r.body.total === 3 && r.body.failed === 2, JSON.stringify(r.body));
    ok('5b the refused row is named (data row 2) with a non-sensitive message', r.body && Array.isArray(r.body.errors) && r.body.errors[0] && r.body.errors[0].row === 2 && /limit/i.test(r.body.errors[0].message) && !/exception|plpgsql|check_violation/i.test(JSON.stringify(r.body)), JSON.stringify(r.body && r.body.errors));
    const after = await venues(L);
    ok('5b database holds exactly 1 venue for the legacy retailer (the first row)', after.length === 1 && after[0].name === 'Legacy 1' && after[0].max_demos_per_slot === 2, JSON.stringify(after));
  }

  // =========================================================================
  console.log('\n-- 6: roles -- viewer/manager 403, owner/admin allowed --');
  // =========================================================================
  for (const [label, ck] of [['viewer', ckViewerP], ['manager', ckManagerP]]) {
    const before = await venueCount(P);
    const r = await importCsv(ck, csvWithCapacity([[`${label} row`, '1']]));
    ok(`6 ${label} -> 403 insufficient_role`, r.statusCode === 403 && r.body && r.body.error === 'insufficient_role', `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok(`6 ${label} inserted nothing`, (await venueCount(P)) === before);
  }
  {
    const r = await importCsv(ckAdminP, csvWithCapacity([['Admin Row', '3']]));
    ok('6 admin -> 200 imported 1', r.statusCode === 200 && r.body.ok === true && r.body.imported === 1, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const r2 = await importCsv(ckOwnerP, csvWithCapacity([['Owner Row', '5']]));
    ok('6 owner -> 200 imported 1', r2.statusCode === 200 && r2.body.ok === true && r2.body.imported === 1, `${r2.statusCode} ${JSON.stringify(r2.body)}`);
    const got = Object.fromEntries((await venues(P)).map(v => [v.name, v.max_demos_per_slot]));
    ok('6 admin/owner rows stored with exact capacities', got['Admin Row'] === 3 && got['Owner Row'] === 5, JSON.stringify(got));
    await clearVenues(P);
    const noCookie = await importCsv(null, csvWithCapacity([['Anon', '1']]));
    ok('6 no session -> 401', noCookie.statusCode === 401, `${noCookie.statusCode} ${JSON.stringify(noCookie.body)}`);
  }

  // =========================================================================
  console.log('\n-- 7: cross-origin is refused before ANY database call --');
  // =========================================================================
  {
    const before = await venueCount(P);
    // Record every Supabase request the route makes while it handles the cross-origin POST. The
    // binding guard's identity probe (api/_env.js verifyDatabaseIdentity) is the ONLY call that may
    // appear: it runs before the CSRF check and touches no tenant table. Nothing may read the session
    // or membership, and nothing may write venues.
    const seen = [];
    const spied = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => { const u = String(url); if (u.includes(process.env.SB_REF)) seen.push(`${String(opts.method || 'GET').toUpperCase()} ${u.split('/rest/v1/')[1] || u}`); return spied(url, opts); };
    let r;
    try { r = await importCsv(ckOwnerP, csvWithCapacity([['Evil Row', '1']]), { csrf: false, origin: 'https://evil.test', headers: { 'sec-fetch-site': 'cross-site' } }); }
    finally { globalThis.fetch = spied; }
    ok('7 cross-site request -> 403 cross_origin_denied', r.statusCode === 403 && r.body && r.body.error === 'cross_origin_denied', `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('7 NO venues write and NO session/membership read happened (only the binding probe may appear)',
      !seen.some(s => /^POST .*venues/.test(s) || /admin_sessions|retailer_admins|venues\?/.test(s)), JSON.stringify(seen));
    ok('7 venue count unchanged', (await venueCount(P)) === before);
    const sibling = await importCsv(ckOwnerP, csvWithCapacity([['Sibling Row', '1']]), { csrf: false, origin: 'https://preview.demohubhq.test', headers: { 'sec-fetch-site': 'same-site' } });
    ok('7 same-SITE sibling origin is refused too', sibling.statusCode === 403 && sibling.body.error === 'cross_origin_denied', `${sibling.statusCode}`);
    const noEvidence = await importCsv(ckOwnerP, csvWithCapacity([['No Origin Row', '1']]), { csrf: false, origin: '' });
    ok('7 a POST with no origin evidence is refused', noEvidence.statusCode === 403 && noEvidence.body.error === 'cross_origin_denied', `${noEvidence.statusCode}`);
    ok('7 venue count still unchanged after sibling/no-evidence attempts', (await venueCount(P)) === before);
  }
} catch (e) {
  console.error('HARNESS ERROR', (e && e.stack) || e);
  ok('harness completed without throwing', false, String((e && e.message) || e));
} finally {
  // Teardown in FK-safe order: venues (created by the route, so by retailer_id) -> sessions -> tokens -> memberships -> retailers.
  for (const rid of [P, S, L]) {
    await db(`venues?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {});
    await db(`admin_sessions?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {});
    await db(`admin_tokens?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const t of ['retailer_admins', 'retailers']) {
    for (const [tt, id] of [...bin].reverse()) { if (tt === t) await db(`${t}?id=eq.${id}`, { method: 'DELETE' }).catch(() => {}); }
  }
  spy.restore();
}
process.exit(summary('venues bulk import (FC-03 strict capacity, fail-closed)') ? 0 : 1);
