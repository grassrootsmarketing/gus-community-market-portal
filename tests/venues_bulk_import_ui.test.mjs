// Execute the live dashboard upload and exit handlers with browser/network doubles.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { runInNewContext } from 'node:vm';

const html = readFileSync('r/gus/admin/index.html', 'utf8');
const section = (from, to) => {
  const start = html.indexOf(from), end = html.indexOf(to, start);
  assert(start >= 0 && end > start, 'dashboard section exists');
  return html.slice(start, end);
};
const csvSource = section('// ===== Bulk CSV store upload =====', '// Calendar feed URL helpers');
const exitSource = section('async function exitImpersonation()', "document.addEventListener('DOMContentLoaded'");

function browser(response, { networkError = false } = {}) {
  const elements = Object.fromEntries(['storeCsvFile', 'storeBulkPreview', 'storeBulkResult', 'storeBulkImportBtn', 'storeBulkModal']
    .map(id => [id, { style: {}, textContent: '', disabled: false, files: [], value: '' }]));
  const calls = [], timers = [], toasts = [];
  let change, refreshes = 0;
  const window = { location: { href: '/r/gus/admin' } };
  const context = {
    document: { getElementById: id => elements[id], addEventListener: (type, fn) => { if (type === 'change') change = fn; } },
    window,
    FormData: class { entries = []; append(...args) { this.entries.push(args); } },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (networkError) throw new Error('network lost');
      return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
    },
    setTimeout: fn => timers.push(fn),
    refreshAll: () => refreshes++,
    DhModal: { toast: (...args) => toasts.push(args) },
  };
  runInNewContext(csvSource + '\n' + exitSource, context);
  const select = file => {
    elements.storeCsvFile.files = file ? [file] : [];
    elements.storeCsvFile.value = file ? file.name : '';
    change({ target: { id: 'storeCsvFile', files: elements.storeCsvFile.files } });
  };
  return { elements, calls, timers, toasts, window, select, upload: () => context.importStoreCsv(),
    exit: () => context.exitImpersonation(), refreshes: () => refreshes };
}

let cases = 0;
const file = { name: '<stores>.csv', size: 35 };
{
  const b = browser({ status: 200, body: { ok: true, imported: 2, total: 2 } });
  b.select(file);
  assert.match(b.elements.storeBulkPreview.textContent, /<stores>\.csv selected/);
  await b.upload();
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].url, '/api/venues-bulk-import');
  assert.equal(b.calls[0].opts.credentials, 'same-origin');
  assert.deepEqual(b.calls[0].opts.body.entries[0], ['csv', file, file.name]);
  assert.match(b.elements.storeBulkResult.textContent, /Imported 2 locations/);
  assert.equal(b.elements.storeCsvFile.value, '');
  assert(b.elements.storeBulkImportBtn.disabled);
  b.timers.forEach(fn => fn());
  assert.equal(b.refreshes(), 1);
  assert.equal(b.elements.storeBulkModal.style.display, 'none');
  cases++;
}
{
  const b = browser({ status: 400, body: { ok: false, error: 'invalid_rows', imported: 0,
    message: 'Nothing was imported.', errors: [{ row: 2, message: '<script>bad capacity</script>' }] } });
  b.select(file);
  await b.upload();
  assert.equal(b.elements.storeBulkResult.textContent, 'Nothing was imported. Row 2: <script>bad capacity</script>');
  assert.equal(b.elements.storeBulkResult.innerHTML, undefined, 'server text is never interpreted as HTML');
  assert.equal(b.refreshes(), 0);
  assert(b.elements.storeBulkImportBtn.disabled);
  cases++;
}
{
  const b = browser({ status: 409, body: { ok: false, imported: 1, total: 3,
    errors: [{ row: 2, message: 'Location limit reached.' }] } });
  b.select(file);
  await b.upload();
  assert.match(b.elements.storeBulkResult.textContent, /Imported 1 of 3 locations/);
  assert.match(b.elements.storeBulkResult.textContent, /only the remaining rows/);
  assert.match(b.elements.storeBulkResult.textContent, /Row 2: Location limit reached/);
  assert.equal(b.refreshes(), 1);
  await b.upload();
  assert.equal(b.calls.length, 1, 'partial import cannot be blindly retried');
  b.select({ name: 'remaining.csv' });
  assert.equal(b.elements.storeBulkImportBtn.disabled, false);
  cases++;
}
{
  const b = browser(null, { networkError: true });
  b.select(file);
  await b.upload();
  assert.match(b.elements.storeBulkResult.textContent, /could not be confirmed/);
  assert.match(b.elements.storeBulkResult.textContent, /Check your locations/);
  assert.equal(b.refreshes(), 1);
  assert(b.elements.storeBulkImportBtn.disabled);
  assert.equal(b.elements.storeCsvFile.disabled, false);
  cases++;
}
{
  const b = browser({ status: 200, body: { ok: true } });
  b.select(file);
  b.select(null);
  await b.upload();
  assert.equal(b.calls.length, 0, 'clearing selection cannot upload stale file');
  assert.equal(b.elements.storeBulkPreview.style.display, 'none');
  cases++;
}
for (const response of [{ status: 503 }, null, { status: 200 }]) {
  const b = browser(response, { networkError: response === null });
  await b.exit();
  assert.equal(b.calls[0].url, '/api/admin-auth');
  assert.equal(JSON.parse(b.calls[0].opts.body).action, 'owner-end-impersonation');
  if (response?.status === 200) {
    assert.equal(b.window.location.href, '/owner');
    assert.equal(b.toasts.length, 0);
  } else {
    assert.equal(b.window.location.href, '/r/gus/admin');
    assert.equal(b.toasts.length, 1);
  }
  cases++;
}
console.log(`dashboard upload and support exit: ${cases} cases passed`);
