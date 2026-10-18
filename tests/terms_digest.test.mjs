// tests/terms_digest.test.mjs (2026-10-18, Codex rev4 item 4): the Terms of Service version and digest a booker accepts
// are pinned to the terms page. A change to the words of terms/index.html fails this test until DEMOHUB_TOS_VERSION and
// DEMOHUB_TOS_DIGEST are bumped together, and the page's "Last updated" date must agree with the version.
import { readFileSync } from 'node:fs';
import { termsDigest, termsVisibleText } from '../tools/terms-digest.mjs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import('../api/booking.js');
const html = readFileSync(new URL('../terms/index.html', import.meta.url), 'utf8');
const digest = termsDigest(html);
ok('the digest constant matches the visible text of terms/index.html', digest === DEMOHUB_TOS_DIGEST, `file ${digest.slice(0, 12)} vs constant ${String(DEMOHUB_TOS_DIGEST).slice(0, 12)}`);
ok('the digest is a sha256 hex string', /^[0-9a-f]{64}$/.test(DEMOHUB_TOS_DIGEST));
const [y, m, d] = DEMOHUB_TOS_VERSION.split('-').map(Number);
const label = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
ok(`the page's "Last updated" date (${label}) agrees with DEMOHUB_TOS_VERSION ${DEMOHUB_TOS_VERSION}`, termsVisibleText(html).includes('Last updated: ' + label), termsVisibleText(html).match(/Last updated:[^.]*/)?.[0]);
ok('the visible text is substantial (not an error page)', termsVisibleText(html).length > 5000);
// the suites accept with a literal version; it must be the real one
for (const f of ['tests/brand_booker.test.mjs', 'tests/brand_booker_corrections.test.mjs']) {
  const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const literals = [...src.matchAll(/terms_version: '([0-9-]+)'/g)].map(x => x[1]);
  ok(`${f} accepts with the real terms version (${literals.length} call(s))`, literals.length > 0 && literals.every(v => v === DEMOHUB_TOS_VERSION), JSON.stringify([...new Set(literals)]));
}
console.log(`\nterms digest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
