#!/usr/bin/env node
// tools/check-html-undef.mjs — no-undef over inline <script> in the HTML pages.
//
// WHY THIS EXISTS, RECORDED HERE BECAUSE THE GAP IS ONLY LEGIBLE NEXT TO THE INCIDENT:
//
//   481237a fixed `productSkus is not defined` in r/gus/index.html. That ReferenceError
//   killed EVERY booking. tools/check-undefined.mjs is a parser-based no-undef check
//   that exists precisely to catch that class -- but line 34 lints `api tools tests`.
//   The booking UI is inline script inside r/gus/index.html, so ESLint never saw it.
//   ~800 KB of inline JavaScript across the pages had no scope analysis at all.
//
//   Confirmed after the fact: running this checker against r/gus/index.html at 1d89c95
//   (the commit before the fix) reports `productSkus is not defined`. The bug was
//   mechanically detectable the whole time; nothing was looking.
//
// SCOPE MODEL, and why each part is needed to avoid lying in either direction:
//
//   line numbers      Each page is rebuilt as a JS file where every script block sits at
//                     its ORIGINAL html line, padded with blank lines. A reported line is
//                     a real line in the .html, so the output is directly actionable.
//   classic merged    Classic <script> blocks on one page share ONE global scope, so they
//                     are linted as a single unit. Linting them separately would report a
//                     function declared in block 1 and called in block 2 as undefined.
//   modules separate  type="module" blocks have their own scope and are linted alone.
//   window.X globals  `window.Foo = ...` inside an IIFE creates a real global that
//                     no-undef cannot see. Without this, r/gus/admin/index.html alone
//                     reported 71 false DhModal hits and drowned the real findings.
//                     Deliberately permissive: a missed bug costs less than 80 false ones.
//
// FAIL CLOSED, per the same principle as .github/workflows/verify.yml: absence of evidence
// must never render as evidence.
//   - ESLint missing            -> exit 2, not a pass
//   - zero pages scanned        -> exit 2; a broken walker must not look like a clean repo
//   - a page fails to PARSE     -> reported as a violation, not skipped
//
// ACCEPTED holds findings reviewed and judged not to be live defects. Each needs a reason.
// An entry that stops firing FAILS THE BUILD: a stale exemption is how a real bug gets
// silently pre-approved later.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let ESLint;
try {
  ({ ESLint } = await import(pathToFileURL(require.resolve('eslint')).href));
} catch {
  console.error('eslint is not installed. Run `npm install` — it is pinned in devDependencies.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Reviewed and accepted. Keyed by file + identifier, NOT line, so ordinary edits
// above them do not silently invalidate the exemption.
// ---------------------------------------------------------------------------
const ACCEPTED = [
  {
    file: 'r/gus/index.html', name: 'updateCart',
    why: 'Guarded by `typeof updateCart === "function"`, which is never true, so no throw. ' +
         'It IS dead: the real function is updateCartDisplay (line ~1319), so the cart is ' +
         'emptied in state without the UI refreshing. Cosmetic staleness, not a crash.',
  },
  {
    file: 'r/gus/index.html', name: 'renderBigCalendar',
    why: 'Orphaned block copied from the admin page. The bigCalPrev/Next/Today buttons live ' +
         'in r/gus/admin/index.html, which defines its own renderBigCalendar. On THIS page ' +
         'nothing calls them and the one live reference is typeof-guarded. Dead code.',
  },
  {
    file: 'r/gus/admin/index.html', name: 'validRows',
    why: 'Unreachable. Line ~5192 is an unconditional `return; // skip old client-side flow`; ' +
         'every validRows reference sits after it. Dead legacy import path.',
  },
  {
    file: 'brand/dashboard/index.html', name: '_maintainBrandAvatarUX',
    why: 'A bare `_maintainBrandAvatarUX = 1;` as the final statement of a sloppy-mode script. ' +
         'Creates an implicit global rather than throwing. A leftover marker, no behaviour.',
  },
];

const BROWSER = [
  'window','document','console','fetch','location','navigator','history','screen','performance',
  'localStorage','sessionStorage','alert','confirm','prompt','setTimeout','clearTimeout',
  'setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','queueMicrotask',
  'URL','URLSearchParams','FormData','Blob','File','FileReader','Image','Audio','Option',
  'Headers','Request','Response','AbortController','AbortSignal','WebSocket','EventSource',
  'crypto','atob','btoa','structuredClone','TextEncoder','TextDecoder','getComputedStyle',
  'matchMedia','IntersectionObserver','MutationObserver','ResizeObserver','CustomEvent','Event',
  'HTMLElement','Element','Node','NodeList','DOMParser','XMLHttpRequest','Notification',
  'caches','indexedDB','self','top','parent','frames','open','close','scrollTo','scrollBy',
  'CSS','Intl','globalThis','ServiceWorkerRegistration','Worker','BroadcastChannel','postMessage',
  'event',
];
// Globals supplied by <script src=...> bundles loaded before the inline code.
const EXTERNAL = ['supabase','Stripe','Chart','dayjs','confetti','gtag','dataLayer','posthog'];

const baseGlobals = Object.fromEntries([...BROWSER, ...EXTERNAL].map((g) => [g, 'readonly']));

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const WINDOW_ASSIGN_RE = /\b(?:window|globalThis|self)\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)/g;
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'supabase']);

function htmlFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (entry.endsWith('.html')) out.push(p);
  }
  return out;
}

function attrsOf(raw) {
  const a = {};
  for (const m of raw.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)) {
    a[(m[1] || m[3]).toLowerCase()] = (m[2] ?? m[4] ?? '').toLowerCase();
  }
  return a;
}

function extract(html) {
  const totalLines = html.split('\n').length;
  const classic = new Array(totalLines + 1).fill('');
  const modules = [];
  let found = 0;

  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = attrsOf(m[1] || '');
    if (attrs.src) continue;
    const type = attrs.type || 'text/javascript';
    if (!/javascript|module|^$/.test(type)) continue;
    const body = m[2];
    if (!body.trim()) continue;
    found++;

    const startLine = html.slice(0, m.index).split('\n').length;
    const openTagLines = m[0].slice(0, m[0].indexOf('>') + 1).split('\n').length - 1;
    const firstBodyLine = startLine + openTagLines;
    const bodyLines = body.split('\n');

    // Index N holds line N; slice(1) drops the placeholder so join() lands each line correctly.
    if (type === 'module') {
      const buf = new Array(totalLines + 1).fill('');
      bodyLines.forEach((l, i) => { if (firstBodyLine + i <= totalLines) buf[firstBodyLine + i] = l; });
      modules.push(buf.slice(1).join('\n'));
    } else {
      bodyLines.forEach((l, i) => { if (firstBodyLine + i <= totalLines) classic[firstBodyLine + i] = l; });
    }
  }
  return { classic: classic.slice(1).join('\n'), modules, found };
}

const root = process.cwd();
const pages = htmlFiles(root);
if (!pages.length) {
  console.error('no .html files found — refusing to report success');
  process.exit(2);
}

const lintFor = (sourceType, pageGlobals) => new ESLint({
  overrideConfigFile: true,
  overrideConfig: {
    languageOptions: { ecmaVersion: 2023, sourceType, globals: { ...baseGlobals, ...pageGlobals } },
    rules: { 'no-undef': 'error' },
  },
});

const accepted = new Map(ACCEPTED.map((a) => [`${a.file}::${a.name}`, { ...a, seen: 0 }]));
const violations = [];
const notes = [];
let scanned = 0;

for (const abs of pages) {
  const rel = relative(root, abs).split(sep).join('/');
  const html = readFileSync(abs, 'utf8');
  const { classic, modules, found } = extract(html);
  if (!found) continue;
  scanned++;

  const pageGlobals = {};
  for (const m of html.matchAll(WINDOW_ASSIGN_RE)) pageGlobals[m[1]] = 'readonly';

  for (const [code, sourceType] of [[classic, 'script'], ...modules.map((m) => [m, 'module'])]) {
    if (!code.trim()) continue;
    let results;
    try {
      results = await lintFor(sourceType, pageGlobals).lintText(code, { filePath: 'inline.js' });
    } catch (e) {
      violations.push(`${rel}  PARSE FAILURE: ${e.message.split('\n')[0]}`);
      continue;
    }
    for (const r of results) {
      for (const msg of r.messages) {
        if (msg.fatal) { violations.push(`${rel}:${msg.line}  PARSE: ${msg.message}`); continue; }
        if (msg.ruleId !== 'no-undef') continue;
        const name = /'([^']+)'/.exec(msg.message)?.[1] ?? '?';
        const hit = accepted.get(`${rel}::${name}`);
        if (hit) { hit.seen++; if (hit.seen === 1) notes.push(`${rel}:${msg.line}  ${name} — accepted`); }
        else violations.push(`${rel}:${msg.line}  ${msg.message}`);
      }
    }
  }
}

console.log(`no-undef checked inline script on ${scanned} page(s)`);
for (const n of notes) console.log('  · ' + n);

const stale = [...accepted.values()].filter((a) => a.seen === 0);
if (stale.length) {
  console.log(`\n${stale.length} STALE EXEMPTION(S) — these no longer fire. Delete them from ACCEPTED:`);
  for (const s of stale) console.log(`  ! ${s.file}  ${s.name}`);
}
if (violations.length) {
  console.log(`\n${violations.length} UNDEFINED IDENTIFIER(S) in inline script — each is a ReferenceError at runtime:`);
  for (const v of violations) console.log('  ✗ ' + v);
}
if (violations.length || stale.length) process.exit(1);
console.log('  ✓ no unaccepted undefined identifiers in inline script');
