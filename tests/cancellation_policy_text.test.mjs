// tests/cancellation_policy_text.test.mjs (David, 2026-10-17): the default cancellation policy says 72 hours, says why,
// and is the SAME sentence in every place it lives (booking route, brand account policy hash, seed, retailer admin
// default, public booking page). A drift between them would change the agreement hash brands accept.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const files = ['api/booking.js', 'api/brand-account.js', 'api/seed-demo.js', 'r/gus/admin/index.html', 'r/gus/index.html'];
const texts = Object.fromEntries(files.map(f => [f, readFileSync(f, 'utf8')]));
const sentence = (texts['api/booking.js'].match(/DEFAULT_CANCELLATION_POLICY = '([^']+)'/) || [])[1];
ok('the booking route defines the default sentence', !!sentence, 'not found');
ok('it says 72 hours, not 48', /72 hours/.test(sentence) && !/48/.test(sentence));
ok('it says why (the store has ordered product) and asks for a week ahead', /ordered product/.test(sentence) && /week ahead/.test(sentence));
ok('reschedules are still welcome', /Reschedules are welcome anytime/.test(sentence));
for (const f of files) ok(`${f} carries the identical sentence`, texts[f].includes(sentence), 'differs');
ok('no file still carries the old 48-hour sentence', !files.some(f => /48 hours before the demo/.test(texts[f])));
ok('no em dashes', !files.some(f => /—/.test(texts[f].split('\n').filter(l => /cancell/i.test(l)).join('\n'))));
// 2026-10-18: the non-refundable store's sentence (api/_refund-cutoff.js) is the same in the admin page and in the 0103
// backfill, and it promises no refund; the admin writes it when the store picks Non-refundable.
const nrFiles = ['api/_refund-cutoff.js', 'r/gus/admin/index.html', 'supabase/migrations/0103_cancellation_mode_72h.sql'];
const nrTexts = Object.fromEntries(nrFiles.map(f => [f, readFileSync(f, 'utf8')]));
const nrSentence = (nrTexts['api/_refund-cutoff.js'].match(/NON_REFUNDABLE_CANCELLATION_POLICY = '([^']+)'/) || [])[1];
ok('api/_refund-cutoff.js defines the non-refundable sentence', !!nrSentence, 'not found');
ok('it says fees are not refunded, says why, and still welcomes reschedules', /not refunded/.test(nrSentence) && /orders product/.test(nrSentence) && /Reschedules are welcome anytime/.test(nrSentence));
ok('it does not mention 72 hours (a non-refundable store makes no window promise)', !/72/.test(nrSentence));
for (const f of nrFiles) ok(`${f} carries the identical non-refundable sentence`, nrTexts[f].includes(nrSentence), 'differs');
ok('the 72-hour sentence is what the admin writes for the refundable choice', nrTexts['r/gus/admin/index.html'].includes("const CANCEL_POLICY_DEFAULT = '" + sentence + "'"));
console.log(`\ncancellation policy text: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
