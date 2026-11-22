// tools/check-html-syntax.mjs (2026-11-22): every inline <script> of every page must PARSE. On 2026-11-21 an apostrophe
// inside a single-quoted string in r/gus/admin/index.html (96b323c) stopped the store admin's whole script on production
// for about five hours; the page was served, so a text check for the new wording passed. This fails the build instead.
// Usage: node tools/check-html-syntax.mjs   (no arguments: every *.html outside node_modules)
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const walk = (d) => readdirSync(d).flatMap((n) => { if (['node_modules', '.git', '.vercel'].includes(n)) return []; const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.html') ? [p] : []); });
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let totalBad = 0, pages = 0;
for (const f of (process.argv.length > 2 ? process.argv.slice(2) : walk('.'))) {
  pages++;
  const html = readFileSync(f, 'utf8');
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m, i = 0, bad = 0;
  while ((m = re.exec(html))) { i++; if (/type=["'](application\/ld\+json|text\/template)/.test(m[1])) continue; try { new vm.Script(m[2], { filename: f + '#' + i }); } catch (e) { bad++; const line = html.slice(0, m.index).split('\n').length + (e.stack.match(/#\d+:(\d+)/) ? +e.stack.match(/#\d+:(\d+)/)[1] - 1 : 0); console.log(f, 'script', i, 'SYNTAX ERROR near line', line, ':', e.message); } }
  totalBad += bad;
}
if (totalBad) { console.error('  ✗ ' + totalBad + ' inline script(s) do not parse'); process.exit(1); }
console.log('  ✓ every inline script on ' + pages + ' pages parses');
