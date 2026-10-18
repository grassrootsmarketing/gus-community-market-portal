// tests/booking_codes_offline.test.mjs: Codex BC R3 (2026-10-13), strict code-list reads. No database, no credentials:
// api/_booking-codes.js listCodes against a scripted sb() helper.
//   * a valid empty result is an empty list, complete on both counts;
//   * a non-array codes result or a non-array redemptions result throws CodesReadError (typed), never an empty list;
//   * an HTTP failure thrown by the helper propagates unchanged;
//   * the 200-code and 500-redemption caps are reported as incomplete when hit, complete when not.
import { listCodes, CodesReadError, CODES_CAP, REDEMPTIONS_CAP } from '../api/_booking-codes.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const codeRow = (i) => ({ id: 'c' + i, code: 'X-' + i, waives_fee: true, waives_lead_time: false, max_uses: 1, use_count: 0, expires_at: null, active: true, note: null, created_by: 'retailer', created_by_email: null, created_at: '2026-10-01T00:00:00Z', deactivated_at: null });
const redRow = (i, codeId) => ({ code_id: codeId, booking_id: 'b' + i, brand_name: 'Brand ' + i, waived_fee: true, waived_lead_time: false, redeemed_at: '2026-10-02T00:00:00Z' });
const sbWith = (codes, reds) => async (path) => { if (path.startsWith('booking_codes?')) { if (codes instanceof Error) throw codes; return codes; } if (path.startsWith('booking_code_redemptions?')) { if (reds instanceof Error) throw reds; return reds; } throw new Error('unexpected path ' + path); };
const rid = '11111111-1111-4111-8111-111111111111';

{
  const r = await listCodes(sbWith([], []), rid);
  ok('valid empty: an empty list, complete on both counts', Array.isArray(r.codes) && r.codes.length === 0 && r.complete.codes === true && r.complete.redemptions === true, JSON.stringify(r));
}
{
  const r = await listCodes(sbWith([codeRow(1), codeRow(2)], [redRow(1, 'c1'), redRow(2, 'c1')]), rid);
  ok('two codes, two redemptions on the first: kinds derived, redemptions attached, complete', r.codes.length === 2 && r.codes[0].kind === 'fee' && r.codes[0].redemptions.length === 2 && r.codes[1].redemptions.length === 0 && r.complete.codes && r.complete.redemptions, JSON.stringify(r.complete));
}
for (const [label, codes, reds, code] of [
  ['codes result is an object (PostgREST error body on a 2xx)', { message: 'nope' }, [], 'codes_unreadable'],
  ['codes result is null', null, [], 'codes_unreadable'],
  ['codes result is a string', 'oops', [], 'codes_unreadable'],
  ['redemptions result is an object', [codeRow(1)], { message: 'nope' }, 'redemptions_unreadable'],
  ['redemptions result is null', [codeRow(1)], null, 'redemptions_unreadable'],
]) {
  let err = null, out = null;
  try { out = await listCodes(sbWith(codes, reds), rid); } catch (e) { err = e; }
  ok(`malformed: ${label} throws CodesReadError ${code}, no list`, err instanceof CodesReadError && err.code === code && out === null, err ? err.name + ':' + err.message : JSON.stringify(out));
}
{
  const boom = new Error('HTTP 503 from PostgREST'); boom.status = 503;
  let err = null; try { await listCodes(sbWith(boom, []), rid); } catch (e) { err = e; }
  ok('HTTP failure on the codes read propagates unchanged (not swallowed, not a CodesReadError)', err === boom, err && err.message);
  let err2 = null; try { await listCodes(sbWith([codeRow(1)], boom), rid); } catch (e) { err2 = e; }
  ok('HTTP failure on the redemptions read propagates unchanged', err2 === boom, err2 && err2.message);
}
{
  const many = Array.from({ length: CODES_CAP }, (_, i) => codeRow(i));
  const r = await listCodes(sbWith(many, []), rid);
  ok(`${CODES_CAP} codes returned (the cap) is reported as incomplete codes`, r.codes.length === CODES_CAP && r.complete.codes === false && r.complete.redemptions === true, JSON.stringify(r.complete));
  const reds = Array.from({ length: REDEMPTIONS_CAP }, (_, i) => redRow(i, 'c0'));
  const r2 = await listCodes(sbWith([codeRow(0)], reds), rid);
  ok(`${REDEMPTIONS_CAP} redemptions returned (the cap) is reported as incomplete redemptions`, r2.codes[0].redemptions.length === REDEMPTIONS_CAP && r2.complete.redemptions === false && r2.complete.codes === true, JSON.stringify(r2.complete));
  const r3 = await listCodes(sbWith(many.slice(0, CODES_CAP - 1), reds.slice(0, REDEMPTIONS_CAP - 1)), rid);
  ok('one under each cap is complete', r3.complete.codes === true && r3.complete.redemptions === true, JSON.stringify(r3.complete));
}
console.log(`\nbooking codes offline (Codex BC R3): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
