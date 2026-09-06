// tests/coi_review_brand_note.test.mjs — Codex Release A §6: the owner's NOTE TO BRAND on a COI
// decision (owner side).
//
// The owner console has two text fields on a COI review: private "Review notes" (coi_verifications.
// review_notes, never brand-facing) and "Note to brand (they will see this)" (coi_verifications.
// brand_note, 0074). The 0074 status trigger copies brand_note into the coi_approved / coi_rejected
// event the brand is emailed from, so this route is the ONLY place that text enters the system and
// it is validated as brand-facing plain text: required on reject, optional on approve, <= 1000
// characters, control characters other than newlines refused (never stripped).
//
// Every assertion goes through the real exported handler with a canonical request (owner cookie
// minted through owner-verify, real CSRF evidence, valid binding) against the staging database.
//
// 0074 GATE. The brand_note column and the widened RPC ship in 0074, which may not be applied to
// the staging database yet. Assertions that need the RPC to ACCEPT p_brand_note are gated on the
// column existing: when it is absent they are listed under "AWAITING 0074" rather than counted as
// failures, so the run still says something true. Validation, authorization and the no-note paths
// (which omit p_brand_note and therefore match the pre-0074 signature) run unconditionally.
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const bin = [];
const track = (path) => { bin.push(path); return path; };
const OWNER_EMAIL = 'david@demohubhq.com';
const future = new Date(Date.now() + 200 * 86400e3).toISOString().slice(0, 10);

const spy = installSpy();

// ---------------------------------------------------------------------------
// 0074 probe: does staging have coi_verifications.brand_note yet?
// ---------------------------------------------------------------------------
const probe = await db('coi_verifications?select=brand_note&limit=1');
const HAS_0074 = probe.ok;
const awaiting = [];
// An assertion that needs the 0074 RPC. Counted normally when the column exists; listed (not failed)
// when it does not.
const okOr0074 = (name, cond, extra = '') => {
  if (HAS_0074) return ok(name, cond, extra);
  awaiting.push(name);
  console.log(`  wait ${name}  (awaits 0074)`);
};
console.log(HAS_0074
  ? 'staging has coi_verifications.brand_note — running the full suite'
  : 'staging does NOT have coi_verifications.brand_note (0074 not applied) — RPC-dependent assertions are listed, not failed');

// ---------------------------------------------------------------------------
// SETUP: owner session the way the product mints it (admin_tokens -> owner-verify), a fixture brand,
// and pending COI versions seeded through finalize_coi_upload (the same RPC upload-coi uses).
// ---------------------------------------------------------------------------
let ownerCookie, brandId;
{
  const ex = await db('retailers?slug=eq.__owner__&select=id');
  const ownerRetailerId = (ex.body && ex.body[0] && ex.body[0].id) ||
    (await db('retailers', { method: 'POST', body: JSON.stringify({
      slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;
  const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRetailerId }) })).body[0];
  track(`admin_tokens?token=eq.${tok.token}`);
  const verified = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }));
  ownerCookie = verified.cookie('dh_owner_session');
  ok('setup: owner-verify through the route yields dh_owner_session', verified.statusCode === 200 && !!ownerCookie, `${verified.statusCode} ${JSON.stringify(verified.body)}`);
  if (ownerCookie) track(`admin_sessions?session_id=eq.${ownerCookie}`);

  const created = await db('brands', { method: 'POST', body: JSON.stringify({
    email: `${uniq('coinote')}@fixture.test`, company_name: 'COI Note Fixture Co' }) });
  brandId = created.body[0].id;
  ok('setup: fixture brand created', !!brandId);
}
// Seed a NEW pending version for the fixture brand; earlier open versions become superseded.
const seedVersion = async () => {
  const vid = crypto.randomUUID();
  const r = await rpc('finalize_coi_upload', {
    p_brand_id: brandId, p_verification_id: vid,
    p_storage_path: `brands/${brandId}/${vid}.pdf`, p_content_sha256: 'sha-' + vid.slice(0, 8),
    p_expires: null, p_status: 'pending' });
  if (!r.ok) throw new Error('finalize_coi_upload failed: ' + JSON.stringify(r.body));
  return vid;
};
const readV = async (vid) => {
  const cols = HAS_0074 ? 'id,status,review_decision,review_notes,brand_note,superseded_at' : 'id,status,review_decision,review_notes,superseded_at';
  return ((await db(`coi_verifications?id=eq.${vid}&select=${cols}`)).body || [])[0];
};
const readBrand = async () => ((await db(`brands?id=eq.${brandId}&select=coi_verification_status,default_coi_expires,current_coi_verification_id`)).body || [])[0];
const review = (body, cookie = ownerCookie) => callRoute('admin-auth.js', req({
  body: { action: 'owner-coi-review', ...body },
  cookies: cookie ? { dh_owner_session: cookie } : {} }));
const unchanged = async (vid, label) => {
  const v = await readV(vid);
  ok(`${label}: record still pending, undecided`, v && v.status === 'pending' && v.review_decision === null, JSON.stringify(v));
};

// ---------------------------------------------------------------------------
// 1. AUTHORIZATION: no owner session -> 401, nothing written.
// ---------------------------------------------------------------------------
console.log('\n1. authorization');
const v1 = await seedVersion();
{
  const anon = await review({ verification_id: v1, decision: 'rejected', brand_note: 'not yours to say' }, null);
  ok('anonymous reject -> 401', anon.statusCode === 401, `${anon.statusCode} ${JSON.stringify(anon.body)}`);
  const bogus = await review({ verification_id: v1, decision: 'approved', expiry: future, brand_note: 'x' }, 'not-a-real-session');
  ok('forged owner cookie -> 401', bogus.statusCode === 401, `${bogus.statusCode}`);
  await unchanged(v1, 'after 401s');
}

// ---------------------------------------------------------------------------
// 2. VALIDATION (all before the RPC is reached, so these hold with or without 0074).
// ---------------------------------------------------------------------------
console.log('\n2. brand_note validation');
{
  const r1 = await review({ verification_id: v1, decision: 'rejected' });
  ok('reject with NO brand_note -> 400 brand_note_required', r1.statusCode === 400 && r1.body && r1.body.error === 'brand_note_required', `${r1.statusCode} ${JSON.stringify(r1.body)}`);
  ok('brand_note_required carries an operator message', r1.body && typeof r1.body.message === 'string' && /emailed/i.test(r1.body.message), JSON.stringify(r1.body));

  const r2 = await review({ verification_id: v1, decision: 'rejected', brand_note: '   \n\n  ' });
  ok('reject with WHITESPACE-ONLY brand_note -> 400 brand_note_required', r2.statusCode === 400 && r2.body && r2.body.error === 'brand_note_required', `${r2.statusCode} ${JSON.stringify(r2.body)}`);

  const r3 = await review({ verification_id: v1, decision: 'rejected', brand_note: 'looks\x00fine' });
  ok('NUL in brand_note -> 400 brand_note_invalid', r3.statusCode === 400 && r3.body && r3.body.error === 'brand_note_invalid', `${r3.statusCode} ${JSON.stringify(r3.body)}`);
  const r4 = await review({ verification_id: v1, decision: 'rejected', brand_note: 'esc\x1b[31mred' });
  ok('ESC in brand_note -> 400 brand_note_invalid', r4.statusCode === 400 && r4.body && r4.body.error === 'brand_note_invalid', `${r4.statusCode}`);
  const r5 = await review({ verification_id: v1, decision: 'rejected', brand_note: 'tab\there' });
  ok('TAB in brand_note -> 400 brand_note_invalid (only newlines allowed)', r5.statusCode === 400 && r5.body && r5.body.error === 'brand_note_invalid', `${r5.statusCode}`);
  const r6 = await review({ verification_id: v1, decision: 'rejected', brand_note: 'del\x7fhere' });
  ok('DEL in brand_note -> 400 brand_note_invalid', r6.statusCode === 400 && r6.body && r6.body.error === 'brand_note_invalid', `${r6.statusCode}`);
  const r7 = await review({ verification_id: v1, decision: 'approved', expiry: future, brand_note: 'x'.repeat(1001) });
  ok('1001-char brand_note -> 400 brand_note_too_long', r7.statusCode === 400 && r7.body && r7.body.error === 'brand_note_too_long', `${r7.statusCode} ${JSON.stringify(r7.body)}`);
  const r8 = await review({ verification_id: v1, decision: 'rejected', brand_note: { text: 'object' } });
  ok('non-string brand_note -> 400 brand_note_invalid', r8.statusCode === 400 && r8.body && r8.body.error === 'brand_note_invalid', `${r8.statusCode}`);
  const r9 = await review({ verification_id: v1, decision: 'approved', brand_note: 'fine note' });
  ok('approve with a note but no expiry -> 400 expiry_required (existing rule kept)', r9.statusCode === 400 && r9.body && r9.body.error === 'expiry_required', `${r9.statusCode}`);
  await unchanged(v1, 'after every 400');
  const b = await readBrand();
  ok('brand entitlement untouched by refused reviews', b && b.coi_verification_status === 'pending', JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// 3. APPROVE with a note -> approved + brand_note stored (+ review_notes stay separate). [0074]
// ---------------------------------------------------------------------------
console.log('\n3. approve with note');
{
  const note = '  Approved — thanks.\r\nCoverage confirmed through ' + future + '.  ';
  const r = await review({ verification_id: v1, decision: 'approved', expiry: future, notes: 'private: insurer checked', brand_note: note });
  okOr0074('approve with note -> 200', r.statusCode === 200 && r.body && r.body.ok === true, `${r.statusCode} ${JSON.stringify(r.body)}`);
  const v = await readV(v1);
  okOr0074('record status approved', v && v.status === 'approved' && v.review_decision === 'approved', JSON.stringify(v));
  okOr0074('brand_note stored trimmed with CRLF normalised to LF', v && v.brand_note === 'Approved — thanks.\nCoverage confirmed through ' + future + '.', JSON.stringify(v && v.brand_note));
  okOr0074('private review_notes stored separately, unchanged', v && v.review_notes === 'private: insurer checked', JSON.stringify(v && v.review_notes));
  const b = await readBrand();
  okOr0074('brand approved with the reviewer expiry (0067 behaviour kept)', b && b.coi_verification_status === 'approved' && b.default_coi_expires === future, JSON.stringify(b));
  ok('response carries no document URL or signed link', r.body && !('url' in r.body) && !JSON.stringify(r.body).includes('coi-docs'), JSON.stringify(r.body));
}

// ---------------------------------------------------------------------------
// 4. ALREADY DECIDED: a second decision on v1 is refused exactly as today (no change).
// ---------------------------------------------------------------------------
console.log('\n4. re-review of a decided version');
{
  if (HAS_0074) {
    const again = await review({ verification_id: v1, decision: 'rejected', brand_note: 'changed my mind' });
    ok('reject of an already-decided version -> 409 already_decided', again.statusCode === 409 && again.body && again.body.error === 'already_decided', `${again.statusCode} ${JSON.stringify(again.body)}`);
    const v = await readV(v1);
    ok('decided record untouched (status + brand_note)', v && v.status === 'approved' && v.brand_note && !/changed my mind/.test(v.brand_note), JSON.stringify(v));
  } else {
    // Pre-0074 the approval above could not commit, so decide v1 note-less here (matches the old
    // signature) and prove the immutability refusal on the no-note path.
    const first = await review({ verification_id: v1, decision: 'approved', expiry: future, notes: 'private only' });
    ok('pre-0074: note-less approve still works (p_brand_note omitted)', first.statusCode === 200, `${first.statusCode} ${JSON.stringify(first.body)}`);
    const again = await review({ verification_id: v1, decision: 'approved', expiry: future });
    ok('second approve of a decided version -> 409 already_decided', again.statusCode === 409 && again.body && again.body.error === 'already_decided', `${again.statusCode} ${JSON.stringify(again.body)}`);
    awaiting.push('reject-with-note of an already-decided version -> 409 already_decided, brand_note untouched');
    console.log('  wait reject-with-note of an already-decided version  (awaits 0074)');
  }
}

// ---------------------------------------------------------------------------
// 5. REJECT with a note on a fresh version -> rejected + brand_note stored. [0074]
// ---------------------------------------------------------------------------
console.log('\n5. reject with note');
const v2 = await seedVersion();
{
  const r = await review({ verification_id: v2, decision: 'rejected', notes: 'private: wrong insured', brand_note: 'The certificate names a different insured party.\nPlease upload one issued to your company.' });
  okOr0074('reject with note -> 200', r.statusCode === 200 && r.body && r.body.decision === 'rejected', `${r.statusCode} ${JSON.stringify(r.body)}`);
  const v = await readV(v2);
  okOr0074('record status rejected', v && v.status === 'rejected' && v.review_decision === 'rejected', JSON.stringify(v));
  okOr0074('brand_note stored verbatim (newlines kept)', v && v.brand_note === 'The certificate names a different insured party.\nPlease upload one issued to your company.', JSON.stringify(v && v.brand_note));
  okOr0074('private review_notes separate from brand_note', v && v.review_notes === 'private: wrong insured' && v.brand_note !== v.review_notes, JSON.stringify(v));
  const b = await readBrand();
  okOr0074('brand entitlement rejected (current version moved it)', b && b.coi_verification_status === 'rejected', JSON.stringify(b));
}

// ---------------------------------------------------------------------------
// 6. SUPERSEDED: approving a stale version is refused as today; brand untouched.
// ---------------------------------------------------------------------------
console.log('\n6. superseded version');
{
  const vOld = await seedVersion();
  const vNew = await seedVersion();          // supersedes vOld
  const old = await readV(vOld);
  ok('older version is superseded by the newer upload', old && old.superseded_at !== null, JSON.stringify(old));
  const before = await readBrand();
  const stale = await review({ verification_id: vOld, decision: 'approved', expiry: future });
  ok('approve of a superseded version (no note) -> 409 stale_review', stale.statusCode === 409 && stale.body && stale.body.error === 'stale_review', `${stale.statusCode} ${JSON.stringify(stale.body)}`);
  await unchanged(vOld, 'stale approve');
  const after = await readBrand();
  ok('brand untouched by the refused stale approval', JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const staleNoted = await review({ verification_id: vOld, decision: 'approved', expiry: future, brand_note: 'should never land' });
  okOr0074('approve of a superseded version WITH a note -> 409 stale_review', staleNoted.statusCode === 409 && staleNoted.body && staleNoted.body.error === 'stale_review', `${staleNoted.statusCode} ${JSON.stringify(staleNoted.body)}`);
  const oldAfter = await readV(vOld);
  okOr0074('no brand_note written on the refused stale version', oldAfter && oldAfter.status === 'pending' && oldAfter.brand_note == null, JSON.stringify(oldAfter));
  ok('the current version is still pending (nothing leaked across versions)', (await readV(vNew)).status === 'pending');
}

// ---------------------------------------------------------------------------
// 7. CONTAINMENT: the owner route itself sends no mail (the brand email is the 0074 trigger +
// worker's job, proven elsewhere), and reaches no payment provider.
// ---------------------------------------------------------------------------
console.log('\n7. containment');
ok('owner-coi-review sent no mail directly', spy.calls.resend.length === 0, `resend calls: ${spy.calls.resend.length}`);
ok('owner-coi-review reached no payment provider', spy.calls.stripe.length === 0, `stripe calls: ${spy.calls.stripe.length}`);

// ---------------------------------------------------------------------------
// TEARDOWN
// ---------------------------------------------------------------------------
for (const r of ((await db(`coi_verifications?brand_id=eq.${brandId}&select=id`)).body || [])) {
  await db(`coi_verifications?id=eq.${r.id}`, { method: 'DELETE' });
}
await db(`brands?id=eq.${brandId}`, { method: 'DELETE' });
for (const p of bin.reverse()) await db(p, { method: 'DELETE' });
spy.restore();

if (awaiting.length) {
  console.log(`\nAWAITING 0074 (${awaiting.length} assertions not run — coi_verifications.brand_note / widened RPC not on this database):`);
  awaiting.forEach(a => console.log('  - ' + a));
}
process.exit(summary('coi_review_brand_note') ? 0 : 1);
