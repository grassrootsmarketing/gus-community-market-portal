// tools/terms-digest.mjs (2026-10-18, Codex rev4 item 4): the digest of the Terms of Service text a booker accepts.
// The digest is of the VISIBLE text of terms/index.html (scripts and styles removed, tags stripped, whitespace collapsed),
// so a markup-only edit does not change it but any change to the words does. api/booking.js carries the current value as
// DEMOHUB_TOS_DIGEST next to DEMOHUB_TOS_VERSION; tests/terms_digest.test.mjs recomputes it from the file.
// Usage: node tools/terms-digest.mjs   (prints the digest and the first words)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function termsVisibleText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export function termsDigest(html) { return createHash('sha256').update(termsVisibleText(html)).digest('hex'); }
if (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1]?.endsWith('terms-digest.mjs')) {
  const html = readFileSync(new URL('../terms/index.html', import.meta.url), 'utf8');
  const text = termsVisibleText(html);
  console.log(termsDigest(html));
  console.log(text.slice(0, 120));
}
