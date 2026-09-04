// tests/status_page.test.mjs
//
// Codex F-07 regression lock for the PUBLIC status page (status/index.html).
// api/find-retailer.js action=status deliberately sends a coarse payload (DH-21):
//   { ok, status, checks: { db:{ok}, cron:{ok, jobs:{<name>:{ok,required}}}, errors:{ok} }, incidents:[{title,severity,started_at}], checked_at }
// The page used to read db.ms / cron.hours_since / cron.outcome / errors.last_24h, which no longer
// exist, and rendered "undefinedms", "never", "undefined 5xx". This OFFLINE test extracts the page's
// pure model + DOM renderer from the inline script and drives them with representative payloads.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

const html = readFileSync(resolve('status/index.html'), 'utf8');
const slice = (from, to) => {
  const i = html.indexOf(from); if (i < 0) throw new Error(`marker not found: ${from}`);
  const j = html.indexOf(to, i); if (j < 0) throw new Error(`end marker not found: ${to}`);
  return html.slice(i, j);
};
const modelSrc = slice('function renderStatusModel(', '// end renderStatusModel');
const rowsSrc = slice('function renderStatusRows(', '// end renderStatusRows');
const renderStatusModel = new Function(modelSrc + '\nreturn renderStatusModel;')();
const renderStatusRows = new Function(rowsSrc + '\nreturn renderStatusRows;')();

// Minimal fake document: enough for the renderer, and serializes the way a browser would —
// textContent is escaped, so any markup that survives serialization raw came from an innerHTML path.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fakeDoc() {
  const mk = (tag) => ({
    tag, className: '', textContent: '', children: [], style: {},
    appendChild(c) { this.children.push(c); return c; },
    toString() {
      const inner = this.children.length ? this.children.map(String).join('') : esc(this.textContent);
      return `<${this.tag}${this.className ? ` class="${this.className}"` : ''}>${inner}</${this.tag}>`;
    },
  });
  return { createElement: mk };
}
const renderToHtml = (payload) => renderStatusRows(renderStatusModel(payload), fakeDoc()).map(String).join('');

const operational = {
  ok: true, status: 'operational',
  checks: {
    db: { ok: true },
    cron: { ok: true, jobs: { 'refund-worker': { ok: true, required: true }, 'provisional-sweep': { ok: true, required: true }, daily: { ok: true, required: true } } },
    errors: { ok: true },
  },
  incidents: [], checked_at: '2026-09-03T12:00:00.000Z',
};

console.log('\n— status page reads only the public schema —');

// 0. Source contract: no reference to the retired fields anywhere in the page script.
{
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  for (const retired of ['.ms', 'hours_since', 'outcome', 'last_24h']) {
    check(`page script no longer references "${retired}"`, !script.includes(retired), `found ${retired}`);
  }
  check('page reads checks.db.ok', /db\.ok/.test(modelSrc));
  check('page reads checks.cron.ok', /cron\.ok/.test(modelSrc));
  check('page reads per-job ok/required from checks.cron.jobs', /cron\.jobs/.test(modelSrc) && /required === false/.test(modelSrc));
  check('page reads checks.errors.ok', /errors\.ok/.test(modelSrc));
  check('row renderer uses textContent, never innerHTML', /textContent/.test(rowsSrc) && !/innerHTML/.test(rowsSrc));
}

// 1. Operational payload: all rows green, banner operational, no undefined/never/NaN.
{
  const m = renderStatusModel(operational);
  check('banner is operational', m.banner === 'operational', m.banner);
  const keys = m.rows.map(r => r.key);
  check('rows: db, cron, three job rows, errors', JSON.stringify(keys) === JSON.stringify(['db', 'cron', 'job:refund-worker', 'job:daily', 'job:provisional-sweep', 'errors']), keys.join(','));
  check('all rows are ok (green)', m.rows.every(r => r.tone === 'ok'), m.rows.map(r => `${r.key}=${r.tone}`).join(' '));
  const names = m.rows.map(r => r.name);
  check('job rows are labelled Refund processing / Daily tasks / Provisional holds sweep',
    names.includes('Refund processing') && names.includes('Daily tasks') && names.includes('Provisional holds sweep'), names.join(' | '));
  const out = renderToHtml(operational);
  for (const bad of ['undefined', 'never', 'NaN', 'null']) {
    check(`rendered rows contain no "${bad}"`, !out.includes(bad), out);
  }
  check('all dots render green', (out.match(/check-dot ok/g) || []).length === 6 && !/check-dot (err|unknown)/.test(out), out);
  check('checked_at parses to a Date', m.checkedAt instanceof Date && !isNaN(m.checkedAt));
}

// 2. Degraded with refund-worker ok:false → that job row red, cron row red, banner degraded.
{
  const degraded = JSON.parse(JSON.stringify(operational));
  degraded.status = 'degraded';
  degraded.checks.cron.ok = false;
  degraded.checks.cron.jobs['refund-worker'].ok = false;
  const m = renderStatusModel(degraded);
  check('banner is degraded', m.banner === 'degraded', m.banner);
  const rw = m.rows.find(r => r.key === 'job:refund-worker');
  check('refund-worker row is red', rw && rw.tone === 'err', rw && rw.tone);
  check('Scheduled jobs summary row is red', m.rows.find(r => r.key === 'cron').tone === 'err');
  check('other job rows stay green', m.rows.filter(r => r.key === 'job:daily' || r.key === 'job:provisional-sweep').every(r => r.tone === 'ok'));
  check('db and errors rows stay green', ['db', 'errors'].every(k => m.rows.find(r => r.key === k).tone === 'ok'));
  const out = renderToHtml(degraded);
  check('rendered degraded output has exactly two red dots', (out.match(/check-dot err/g) || []).length === 2, out);
  check('rendered degraded output has no "undefined"/"never"', !/undefined|never|NaN/.test(out), out);
}

// 3. provisional-sweep required:false → neutral (not red) regardless of ok.
{
  const p = JSON.parse(JSON.stringify(operational));
  p.checks.cron.jobs['provisional-sweep'] = { ok: false, required: false };
  const m = renderStatusModel(p);
  const ps = m.rows.find(r => r.key === 'job:provisional-sweep');
  check('provisional-sweep required:false renders neutral', ps && ps.tone === 'neutral', ps && ps.tone);
  check('provisional-sweep required:false reads "Not required"', ps && /not required/i.test(ps.value), ps && ps.value);
  const out = renderToHtml(p);
  check('neutral row renders as a grey (unknown) dot, never err', !/check-dot err/.test(out) && /check-dot unknown/.test(out), out);
  check('banner stays operational (status is authoritative)', m.banner === 'operational');
}

// 4. A job missing from jobs → no row for it.
{
  const p = JSON.parse(JSON.stringify(operational));
  delete p.checks.cron.jobs['daily'];
  const m = renderStatusModel(p);
  check('a job absent from checks.cron.jobs gets no row', !m.rows.some(r => r.key === 'job:daily'), m.rows.map(r => r.key).join(','));
  check('present jobs still render', m.rows.some(r => r.key === 'job:refund-worker') && m.rows.some(r => r.key === 'job:provisional-sweep'));
}

// 5. Hostile strings anywhere in the payload are rendered as text, never as markup.
{
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const p = JSON.parse(JSON.stringify(operational));
  p.status = hostile;
  p.checks.db.ok = hostile;                 // non-boolean → unknown, not interpolated
  p.checks.cron.jobs[hostile] = { ok: true, required: true };   // unknown job name → ignored
  p.checks.cron.jobs['daily'].ok = hostile;
  p.incidents = [{ title: hostile, severity: hostile, started_at: hostile }];
  p.checked_at = hostile;
  const m = renderStatusModel(p);
  const out = renderToHtml(p);
  check('hostile payload renders no raw <img or <script tag', !out.includes('<img') && !out.includes('<script'), out);
  check('hostile job name does not create a row', !m.rows.some(r => r.name === hostile || r.key.includes('<')));
  check('non-boolean ok values fall back to unknown, not to the string', m.rows.find(r => r.key === 'db').tone === 'unknown' && !JSON.stringify(m.rows).includes('<img'));
  check('unknown status falls back to degraded banner', m.banner === 'degraded', m.banner);
  check('hostile incident severity is normalised to a known value', ['minor', 'major', 'maintenance'].includes(m.incidents[0].severity), m.incidents[0].severity);
  check('incident title is kept as a plain string (rendered via textContent in the page)', m.incidents[0].title === hostile);
  check('invalid started_at/checked_at become null, not "Invalid Date"', m.incidents[0].startedAt === null && m.checkedAt === null);
  // The incident renderer in loadStatus must also use textContent for title/severity.
  const incidentSrc = slice('if (model.incidents.length > 0)', "if (model.banner === 'operational')");
  check('incident cards set title via textContent, never innerHTML', /head\.textContent\s*=/.test(incidentSrc) && !/innerHTML/.test(incidentSrc), incidentSrc.slice(0, 200));
}

// 6. Missing / malformed checks degrade to unknown rows rather than throwing.
{
  let threw = false, m;
  try { m = renderStatusModel({ ok: true, status: 'degraded' }); } catch (e) { threw = true; }
  check('payload without checks does not throw', !threw);
  check('payload without checks yields unknown db/cron/errors rows and no job rows',
    m && m.rows.length === 3 && m.rows.every(r => r.tone === 'unknown'), m && m.rows.map(r => `${r.key}=${r.tone}`).join(' '));
  let threw2 = false;
  try { renderStatusModel(null); renderStatusModel('x'); renderStatusModel({ checks: { cron: { jobs: null } } }); } catch (e) { threw2 = true; }
  check('null / string / malformed payloads do not throw', !threw2);
}

console.log(`\nstatus page: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
