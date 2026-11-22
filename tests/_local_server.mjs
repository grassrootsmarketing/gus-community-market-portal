// tests/_local_server.mjs (2026-11-22): the local server the *_dom.e2e.mjs suites expect at DOM_BASE, as its own process.
// Static pages with the same clean URLs and store rewrite as vercel.json, and /api/<name> run by the REAL handler with
// the harness environment (tests/_route.mjs: the test database demohub-rebuild-check, payment and mail providers spied,
// so nothing is charged and nothing is sent). It is the server inside tests/multi_brand_dom.e2e.mjs, made reusable.
// Usage: SB_URL / SB_KEY / SB_REF from demohub.env, then  node tests/_local_server.mjs [port=4174] [seconds=900]
// It stops by itself after the given time, so nothing is left running.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { installSpy, ENV } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';

const PORT = Number(process.argv[2] || 4174), SECONDS = Number(process.argv[3] || 900);
const BASE = `http://localhost:${PORT}`;
ENV.SITE_ORIGIN = BASE;
for (const kv of (process.env.LOCAL_SERVER_ENV || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); ENV[k] = v; }
installSpy();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.css': 'text/css' };
const handlers = new Map();
async function runApi(name, nreq, nres, url) {
  process.env = { ...ENV };
  _resetBindingCache();
  if (!handlers.has(name)) handlers.set(name, (await import(pathToFileURL(resolve('api', name + '.js')).href)).default);
  let raw = ''; for await (const c of nreq) raw += c;
  let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }
  const reqLike = { method: nreq.method, headers: nreq.headers, query: Object.fromEntries(url.searchParams), body, socket: { remoteAddress: '203.0.113.9' }, url: nreq.url, on() {} };
  const res = {
    statusCode: 200,
    setHeader(k, v) { nres.setHeader(k, v); return this; }, getHeader(k) { return nres.getHeader(k); },
    status(c) { this.statusCode = c; return this; },
    json(b) { nres.statusCode = this.statusCode; if (!nres.getHeader('Content-Type')) nres.setHeader('Content-Type', 'application/json'); nres.end(JSON.stringify(b)); return this; },
    send(b) { nres.statusCode = this.statusCode; nres.end(typeof b === 'string' ? b : JSON.stringify(b)); return this; },
    end(b) { nres.statusCode = this.statusCode; nres.end(b); return this; },
  };
  await handlers.get(name)(reqLike, res);
}
http.createServer(async (nreq, nres) => {
  try {
    const url = new URL(nreq.url, BASE);
    let p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) {
      const name = p.slice(5).replace(/[^a-z0-9_-]/gi, '');
      if (!existsSync(resolve('api', name + '.js')) || name.startsWith('_')) { nres.statusCode = 404; return nres.end('{}'); }
      return await runApi(name, nreq, nres, url);
    }
    const m = /^\/r\/[^/]+(\/.*)?$/.exec(p);
    if (m) p = '/r/gus' + (m[1] || '');
    let file = join(process.cwd(), p);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    else if (!existsSync(file) && existsSync(file + '.html')) file += '.html';
    if (!existsSync(file) || !statSync(file).isFile()) { nres.statusCode = 404; return nres.end('not found'); }
    nres.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    nres.setHeader('Cache-Control', 'no-store');
    nres.end(readFileSync(file));
  } catch (e) { nres.statusCode = 500; nres.end(String(e && e.message)); }
}).listen(PORT, () => console.log('local server on', BASE, 'for', SECONDS, 'seconds'));
setTimeout(() => process.exit(0), SECONDS * 1000);
