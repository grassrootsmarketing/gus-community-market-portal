// tests/compliance_tenant.test.mjs — Codex F-02: cross-retailer compliance relationship injection.
//
// Runs the REAL exported handlers (api/admin.js, api/admin-auth.js, api/coi-enforcement.js) through
// tests/_route.mjs against staging, with real role cookies minted through the real verify route.
//
// The defect: compliance_records.brand_contact_id was only checked for EXISTENCE (single-column FK),
// so Retailer A could file a compliance record against Retailer B's contact, and both readers of that
// link (the hourly enforcement worker, the daily COI-warning job) followed it across the tenant line.
//
// What this file proves, at the response / row level:
//   F1  A cannot link a compliance record to B's contact (404 not_found), and a foreign contact id is
//       indistinguishable from a nonexistent one (no enumeration); non-UUID ids get one uniform 400;
//       linking A's OWN contact still works and the row is pinned to A.
//   F2  server-owned fields (coi_warn_*_sent_at, created_at, retailer_id, id) in a client body are
//       ignored / pinned; an expires_at change resets the warn cursors.
//   F3  A cannot RE-link an existing record to B's contact (404, row unchanged).
//   F4  the DATABASE refuses (brand_contact_id=B, retailer_id=A) outright — FK 23503 from migration
//       0071 — and compliance_tenant_anomalies() reports zero rows.
//   F5  file_url is validated: javascript: -> 400 invalid_file_url, https accepted, '' stored as null.
//   F6  enforcement scoping: a COI record at Retailer A for a brand's contact does NOT cover that
//       brand's booking at Retailer B, and DOES cover its booking at Retailer A. Driven through the
//       real cron route in dry_run mode (decisions computed, nothing written, no mail, no Stripe).
//
// PREFLIGHT: if migration 0071 has not been applied to the target database the RPC is missing (404)
// and this file FAILS loudly, then continues — the F4 assertions fail honestly rather than being
// skipped, and everything created here is still torn down in FK-safe order.
//
// Run from the repository root with staging creds:  node tests/compliance_tenant.test.mjs
import { ENV, installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

// api/_flags.js reads env ONCE at first import. admin.js / admin-auth.js do not import it;
// coi-enforcement.js does, so these must be on the harness ENV before that route is first loaded.
// dry_run = the worker computes and reports decisions but performs no write, email or refund.
ENV.COI_AUTO_ENFORCEMENT_ENABLED = 'true';
ENV.COI_ENFORCEMENT_MODE = 'dry_run';

const SB = process.env.SB_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function db(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text: t };
}
// api/admin.js replies through send() (always a JSON string); coi-enforcement.js uses res.json(). Normalise.
const parse = (r) => { const b = r && r.body; if (typeof b === 'string') { try { return JSON.parse(b); } catch (_) { return b; } } return b; };
const one = (r) => { const b = parse(r); return Array.isArray(b) ? b[0] : b; };
const wrap = (r) => ({ statusCode: r.statusCode, body: parse(r), cookie: (n) => r.cookie(n) });
const sig = (r) => `${r.statusCode} ${JSON.stringify(r.body)}`;
const bin = []; // [table, id] in creation order; torn down in reverse
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const must = (label, r) => { const row = one(r); if (!row || !row.id) throw new Error(`fixture ${label} failed: ${r.status} ${r.text}`); return row; };

const spy = installSpy();

// ---------------------------------------------------------------------------
// Preflight: is 0071 on this database?
// ---------------------------------------------------------------------------
let applied = false;
{
  const r = await db('rpc/compliance_tenant_anomalies', { method: 'POST', body: '{}' });
  applied = r.ok && Array.isArray(r.body);
  ok('PREFLIGHT migration 0071 is applied (rpc compliance_tenant_anomalies callable)', applied,
    applied ? '' : `0071 has NOT been applied to staging — rpc/compliance_tenant_anomalies -> ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  if (!applied) console.log('  !!  0071 has NOT been applied to staging. The F4 database-level assertions below WILL fail until it is.');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slugA = uniq('ct-a'), slugB = uniq('ct-b');
const mkRetailer = async (slug, name) => track('retailers', must('retailer', await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name, billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true }) })).id);
const mkVenue = async (rid, name) => track('venues', must('venue', await db('venues', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, name, address: '1 Tenant St', demo_fee: 30, max_demos_per_slot: 5 }) })).id);
const mkContact = async (rid, name, email) => track('brand_contacts', must('contact', await db('brand_contacts', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, name, company: 'CT Brand Co', email }) })).id);
const mkMember = async (rid, email, role) => track('retailer_admins', must('member', await db('retailer_admins', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, email, email_normalized: email, name: role + ' fixture', role }) })).id);
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
async function mintCookie(rid, email) {
  const tr = await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: rid }) });
  const tok = one(tr);   // admin_tokens has no id column: the token IS the key
  if (!tok || !tok.token) throw new Error(`fixture token failed: ${tr.status} ${tr.text}`);
  const v = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  if (v.statusCode !== 200) throw new Error('verify failed for ' + email + ': ' + v.statusCode + ' ' + JSON.stringify(v.body));
  return v.cookie('dh_retailer_session');
}
const proxy = async (cookie, method, table, body, id) => wrap(await callRoute('admin.js', req({ method, query: { table, ...(id ? { id } : {}) }, body, cookies: { dh_retailer_session: cookie } })));
const recRow = async (id, sel = '*') => one(await db(`compliance_records?id=eq.${id}&select=${sel}`));

let A = null, B = null;
try {
  A = await mkRetailer(slugA, 'Tenant Retailer A');
  B = await mkRetailer(slugB, 'Tenant Retailer B');
  const A1 = await mkVenue(A, 'A1'), B1 = await mkVenue(B, 'B1');
  // The brand is APPROVED but carries NO brand-level certificate, so the only thing that can ever
  // cover one of its bookings is a compliance record — exactly the source F-02 is about.
  const brandEmail = `${uniq('ct-brand')}@fixture.test`;
  const brand = must('brand', await db('brands', { method: 'POST', body: JSON.stringify({
    email: brandEmail, company_name: 'CT Brand Co', is_verified: true, contact_name: 'CT Brand', phone: '555-0100',
    coi_verification_status: 'approved' }) }));
  track('brands', brand.id);
  const CA = await mkContact(A, 'A Contact', brandEmail);            // A's own contact for the brand
  const CB = await mkContact(B, 'B Contact', 'b-contact@fixture.test');
  const ownerAEmail = `owner-${slugA}@fixture.test`, ownerBEmail = `owner-${slugB}@fixture.test`;
  await mkMember(A, ownerAEmail, 'owner');
  await mkMember(B, ownerBEmail, 'owner');
  const ownerA = await mintCookie(A, ownerAEmail);
  await mintCookie(B, ownerBEmail);   // B's session exists (realistic tenancy); every attack below is A's

  // =========================================================================
  console.log('\n— F1: a compliance record cannot be linked to another tenant\'s contact —');
  // =========================================================================
  let rec = null;
  {
    const foreign = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', expires_at: '2027-12-31', brand_contact_id: CB });
    ok('F1 POST with Retailer B contact -> 404 not_found', foreign.statusCode === 404 && foreign.body && foreign.body.error === 'not_found', sig(foreign));
    const ghost = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', expires_at: '2027-12-31', brand_contact_id: crypto.randomUUID() });
    ok('F1 POST with nonexistent contact -> 404 not_found', ghost.statusCode === 404 && ghost.body && ghost.body.error === 'not_found', sig(ghost));
    ok('F1 foreign contact and nonexistent contact are INDISTINGUISHABLE (status + body)', sig(foreign) === sig(ghost), `${sig(foreign)} vs ${sig(ghost)}`);
    const rowsA = (await db(`compliance_records?retailer_id=eq.${A}&select=id`)).body || [];
    ok('F1 neither refused attempt created a row', rowsA.length === 0, JSON.stringify(rowsA));

    const bad = [];
    for (const v of ['not-a-uuid', '123', CB + "'", 'null', 'eq.' + CB]) {
      bad.push(await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', brand_contact_id: v }));
    }
    ok('F1 non-UUID brand_contact_id -> 400 invalid_brand_contact_id (never reaches Postgres)', bad.every(r => r.statusCode === 400 && r.body && r.body.error === 'invalid_brand_contact_id'), bad.map(sig).join(' | '));
    ok('F1 every malformed value gets the IDENTICAL response', new Set(bad.map(sig)).size === 1, bad.map(sig).join(' | '));

    // Own contact: works, and server-owned keys in the same body are ignored (F2).
    const mine = await proxy(ownerA, 'POST', 'compliance_records', {
      doc_type: 'coi', doc_number: 'CT-1', expires_at: '2027-12-31', verified: true, brand_contact_id: CA,
      coi_warn_30_sent_at: '2020-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z', id: crypto.randomUUID(),
    });
    rec = one(mine); if (rec && rec.id) track('compliance_records', rec.id);
    ok('F1 POST with OWN contact -> 201', mine.statusCode === 201 && rec && rec.id, sig(mine).slice(0, 200));
    const row = rec && rec.id ? await recRow(rec.id) : null;
    ok('F1 stored row is pinned to Retailer A and linked to A\'s contact', !!row && row.retailer_id === A && row.brand_contact_id === CA, JSON.stringify(row));
    ok('F2 client coi_warn_30_sent_at ignored (stored null)', !!row && row.coi_warn_30_sent_at === null, JSON.stringify(row && row.coi_warn_30_sent_at));
    ok('F2 client created_at ignored (server timestamp, not 2020)', !!row && !String(row.created_at).startsWith('2020'), JSON.stringify(row && row.created_at));
    ok('F2 client id ignored (server-generated uuid)', !!row && row.id === rec.id && row.doc_number === 'CT-1');
  }
  if (!rec || !rec.id) throw new Error('own-contact record was not created; cannot continue');

  // =========================================================================
  console.log('\n— F3: an existing record cannot be RE-linked across the tenant line —');
  // =========================================================================
  {
    const p = await proxy(ownerA, 'PATCH', 'compliance_records', { brand_contact_id: CB }, rec.id);
    ok('F3 PATCH own record to Retailer B contact -> 404 not_found', p.statusCode === 404 && p.body && p.body.error === 'not_found', sig(p));
    const after = await recRow(rec.id, 'brand_contact_id,retailer_id');
    ok('F3 row unchanged (still A\'s contact, still Retailer A)', !!after && after.brand_contact_id === CA && after.retailer_id === A, JSON.stringify(after));

    // F2 on PATCH: retailer_id pinned, id dropped, coi_warn_* ignored, allowed field applied.
    const p2 = await proxy(ownerA, 'PATCH', 'compliance_records', { doc_number: 'CT-2', retailer_id: B, id: crypto.randomUUID(), coi_warn_14_sent_at: '2020-01-01T00:00:00Z' }, rec.id);
    const after2 = await recRow(rec.id, 'id,retailer_id,doc_number,coi_warn_14_sent_at');
    ok('F2 PATCH cannot move the row to Retailer B (pinned to A)', p2.statusCode < 300 && !!after2 && after2.retailer_id === A, `${p2.statusCode} ${JSON.stringify(after2)}`);
    ok('F2 PATCH coi_warn_14_sent_at ignored, doc_number applied', !!after2 && after2.coi_warn_14_sent_at === null && after2.doc_number === 'CT-2', JSON.stringify(after2));

    // Expiry change resets the warn cursors (server-set nulls survive the allowlist).
    await db(`compliance_records?id=eq.${rec.id}`, { method: 'PATCH', body: JSON.stringify({ coi_warn_30_sent_at: new Date().toISOString() }) });
    const p3 = await proxy(ownerA, 'PATCH', 'compliance_records', { expires_at: '2028-01-31' }, rec.id);
    const after3 = await recRow(rec.id, 'expires_at,coi_warn_30_sent_at,coi_warn_14_sent_at,coi_warn_3_sent_at');
    ok('F2 PATCH expires_at applies AND resets the warn cursors', p3.statusCode < 300 && !!after3 && after3.expires_at === '2028-01-31' && after3.coi_warn_30_sent_at === null && after3.coi_warn_14_sent_at === null, `${p3.statusCode} ${JSON.stringify(after3)}`);
    // restore the coverage window used by F6
    await db(`compliance_records?id=eq.${rec.id}`, { method: 'PATCH', body: JSON.stringify({ expires_at: '2027-12-31' }) });
  }

  // =========================================================================
  console.log('\n— F4: the DATABASE itself refuses a cross-tenant link (migration 0071) —');
  // =========================================================================
  {
    const direct = await db('compliance_records', { method: 'POST', body: JSON.stringify({ retailer_id: A, brand_contact_id: CB, doc_type: 'coi', doc_number: 'ANOMALY' }) });
    if (direct.ok) { const r = one(direct); if (r && r.id) track('compliance_records', r.id); }
    ok('F4 direct service-role insert of (contact B, retailer A) fails with FK violation 23503', !direct.ok && direct.body && direct.body.code === '23503', `${direct.status} ${JSON.stringify(direct.body).slice(0, 200)}`);
    const upd = await db(`compliance_records?id=eq.${rec.id}`, { method: 'PATCH', body: JSON.stringify({ brand_contact_id: CB }) });
    ok('F4 direct service-role UPDATE to a foreign contact fails with FK violation 23503', !upd.ok && upd.body && upd.body.code === '23503', `${upd.status} ${JSON.stringify(upd.body).slice(0, 200)}`);
    const still = await recRow(rec.id, 'brand_contact_id');
    ok('F4 record still points at A\'s contact', !!still && still.brand_contact_id === CA, JSON.stringify(still));
    if (still && still.brand_contact_id !== CA) await db(`compliance_records?id=eq.${rec.id}`, { method: 'PATCH', body: JSON.stringify({ brand_contact_id: CA }) });
    const rpc = await db('rpc/compliance_tenant_anomalies', { method: 'POST', body: '{}' });
    ok('F4 compliance_tenant_anomalies() returns 0 rows', rpc.ok && Array.isArray(rpc.body) && rpc.body.length === 0, `${rpc.status} ${JSON.stringify(rpc.body).slice(0, 200)}`);
    const unlinked = await db('compliance_records', { method: 'POST', body: JSON.stringify({ retailer_id: A, brand_contact_id: null, doc_type: 'permit' }) });
    const u = one(unlinked); if (u && u.id) track('compliance_records', u.id);
    ok('F4 an UNLINKED record (brand_contact_id null) is still accepted (MATCH SIMPLE)', unlinked.ok && u && u.brand_contact_id === null, `${unlinked.status} ${JSON.stringify(unlinked.body).slice(0, 160)}`);
  }

  // =========================================================================
  console.log('\n— F5: file_url validation —');
  // =========================================================================
  {
    const js = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', file_url: 'javascript:alert(1)' });
    ok('F5 file_url javascript: -> 400 invalid_file_url', js.statusCode === 400 && js.body && js.body.error === 'invalid_file_url', sig(js));
    const dataUrl = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', file_url: 'data:text/html,hi' });
    ok('F5 file_url data: -> 400 invalid_file_url', dataUrl.statusCode === 400 && dataUrl.body && dataUrl.body.error === 'invalid_file_url', sig(dataUrl));
    const breakout = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', file_url: 'https://x.test/a.pdf" onerror="x' });
    ok('F5 file_url with attribute-breakout characters -> 400 invalid_file_url', breakout.statusCode === 400 && breakout.body && breakout.body.error === 'invalid_file_url', sig(breakout));
    const goodR = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', file_url: 'https://x.test/a.pdf' });
    const good = one(goodR); if (good && good.id) track('compliance_records', good.id);
    ok('F5 file_url https accepted and stored verbatim', goodR.statusCode === 201 && good && good.file_url === 'https://x.test/a.pdf', sig(goodR).slice(0, 160));
    const emptyR = await proxy(ownerA, 'POST', 'compliance_records', { doc_type: 'coi', file_url: '' });
    const empty = one(emptyR); if (empty && empty.id) track('compliance_records', empty.id);
    ok('F5 file_url \'\' stored as null', emptyR.statusCode === 201 && empty && empty.file_url === null, sig(emptyR).slice(0, 160));
    const pr = await proxy(ownerA, 'PATCH', 'compliance_records', { file_url: 'javascript:alert(2)' }, rec.id);
    ok('F5 PATCH file_url javascript: -> 400 invalid_file_url', pr.statusCode === 400 && pr.body && pr.body.error === 'invalid_file_url', sig(pr));
    const rows = (await db(`compliance_records?retailer_id=eq.${A}&file_url=like.*javascript*&select=id`)).body || [];
    ok('F5 no javascript: URL was ever stored', rows.length === 0, JSON.stringify(rows));
  }

  // =========================================================================
  console.log('\n— F6: enforcement scoping — Retailer A\'s record never covers a Retailer B booking —');
  // =========================================================================
  {
    const mkBooking = async (rid, vid, t) => {
      const row = must('booking', await db('bookings', { method: 'POST', body: JSON.stringify({
        retailer_id: rid, venue_id: vid, brand_id: brand.id, brand_name: brand.company_name, contact_name: brand.contact_name,
        contact_email: brand.email, demo_date: plusDays(8), demo_time: t, status: 'confirmed', payment_status: 'paid', amount_paid: 3000 }) }));
      track('bookings', row.id); return row;
    };
    const bkA = await mkBooking(A, A1, '10:00');
    const bkB = await mkBooking(B, B1, '11:00');
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const run = await callRoute('coi-enforcement.js', req({ method: 'POST', headers: { authorization: 'Bearer ' + ENV.CRON_SECRET } }));
    const body = parse(run) || {};
    ok('F6 enforcement route ran in dry_run (200)', run.statusCode === 200 && body.mode === 'dry_run', `${run.statusCode} ${JSON.stringify(body).slice(0, 160)}`);
    const decisions = Array.isArray(body.decisions) ? body.decisions : [];
    const errors = Array.isArray(body.errors) ? body.errors : [];
    const decA = decisions.find(d => d.booking === bkA.id), decB = decisions.find(d => d.booking === bkB.id);
    const errA = errors.find(e => e.booking === bkA.id), errB = errors.find(e => e.booking === bkB.id);
    ok('F6 both fixture bookings were examined (in the 10-day window, paid, confirmed)', body.checked >= 2 && !errA && !errB, JSON.stringify({ checked: body.checked, errA, errB }));
    ok('F6 Retailer B booking: Retailer A\'s record is NOT considered -> coverage "missing"', !!decB && decB.coverage === 'missing', JSON.stringify(decB));
    ok('F6 Retailer A booking: its own record IS considered -> covered (no decision, no error)', !decA && !errA, JSON.stringify({ decA, errA }));
    ok('F6 dry_run reached no provider: zero Stripe, zero Resend calls', spy.calls.stripe.length === 0 && spy.calls.resend.length === 0, JSON.stringify({ stripe: spy.calls.stripe.length, resend: spy.calls.resend.length }));
    const bB = one(await db(`bookings?id=eq.${bkB.id}&select=status,coi_reminder_sent_at,coi_final_warn_sent_at,cancelled_at`));
    ok('F6 Retailer B booking row untouched', !!bB && bB.status === 'confirmed' && !bB.coi_reminder_sent_at && !bB.coi_final_warn_sent_at && !bB.cancelled_at, JSON.stringify(bB));
  }
} catch (e) {
  console.error('HARNESS ERROR', (e && e.stack) || e);
  ok('harness completed without throwing', false, String((e && e.message) || e));
} finally {
  // Teardown in FK-safe order (children first).
  const order = ['bookings', 'compliance_records', 'brand_contacts', 'admin_tokens', 'retailer_admins', 'venues', 'brands', 'retailers'];
  for (const t of order) {
    if (t === 'admin_tokens') {
      for (const rid of [A, B].filter(Boolean)) {
        await db(`admin_sessions?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {});
        await db(`admin_tokens?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {});
      }
      continue;
    }
    for (const [tt, id] of [...bin].reverse()) { if (tt === t) await db(`${t}?id=eq.${id}`, { method: 'DELETE' }).catch(() => {}); }
  }
}
process.exit(summary('compliance tenant integrity (Codex F-02)') ? 0 : 1);
