// tests/capacity_input.test.mjs
//
// Codex F-08 regression lock for venue capacity (venues.max_demos_per_slot) in r/gus/admin/index.html.
// The column is NOT NULL and a CHECK (max_demos_per_slot >= 1) is being added; the UI used to offer
// "0 = No limit" and persist null. This OFFLINE test extracts parseCapacityInput() from the inline
// script and proves the rule at every entry point:
//   * single-venue save (saveAvailability)            -> parseCapacityInput, stops on error, never null
//   * "Apply to all locations" (applyScheduleToAllStores) -> same
//   * CSV bulk import preview (row parse + import gate) -> invalid rows rejected with a per-row message
//   * the input element itself                          -> type=number min=1 step=1, no "No limit" option
// Rule: whole numbers >= 1 only. "0", negatives, blanks, non-numeric AND decimals ("2.7") are rejected
// with a message — never floored, never silently coerced to 1, never sent as null.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

const html = readFileSync(resolve('r/gus/admin/index.html'), 'utf8');
const slice = (from, to) => {
  const i = html.indexOf(from); if (i < 0) throw new Error(`marker not found: ${from}`);
  const j = html.indexOf(to, i); if (j < 0) throw new Error(`end marker not found: ${to}`);
  return html.slice(i, j);
};
const fnSrc = slice('function parseCapacityInput(', 'window.parseCapacityInput = parseCapacityInput;');
const parseCapacityInput = new Function(fnSrc + '\nreturn parseCapacityInput;')();

console.log('\n— capacity input: whole number >= 1, never null —');

// 1. The parser.
{
  const rejected = ['0', '-1', 'abc', '', '   ', '2.7', '1.0', '0.9', 'null', 'NaN', '1e2', '+3', null, undefined, 0, -5, 2.5];
  for (const v of rejected) {
    const r = parseCapacityInput(v);
    check(`rejects ${JSON.stringify(v)}`, r && r.ok === false && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
    check(`rejection of ${JSON.stringify(v)} carries a user-facing message`, r && /whole number|at least 1|required/i.test(r.error || ''), r && r.error);
  }
  const accepted = [['1', 1], ['2', 2], [' 2 ', 2], ['07', 7], ['50', 50], [3, 3]];
  for (const [v, want] of accepted) {
    const r = parseCapacityInput(v);
    check(`accepts ${JSON.stringify(v)} -> ${want}`, r && r.ok === true && r.value === want && Number.isInteger(r.value), JSON.stringify(r));
  }
  check('decimal "2.7" is REJECTED (not floored to 2)', parseCapacityInput('2.7').ok === false && parseCapacityInput('2.7').value === undefined);
  // Exhaustive: no input can produce ok:true with a non-integer or < 1 value, and no result carries null.
  const fuzz = ['0', '00', '-0', '1', '2', '999', '1.5', 'x', '', ' ', '0x10', '1 2', '２', null, undefined, 0, 1, NaN, Infinity, -1, true, false, {}, []];
  const bad = fuzz.filter(v => { const r = parseCapacityInput(v); return r.ok ? !(Number.isInteger(r.value) && r.value >= 1) : (r.value === null || 'value' in r); });
  check('no input yields an accepted value < 1, non-integer, or null', bad.length === 0, JSON.stringify(bad));
}

// 2. Single-venue save (saveAvailability) uses the parser, stops on error, and never sends null.
{
  const fn = slice('async function saveAvailability()', 'function ') ;
  const saveFn = slice('async function saveAvailability()', '// Delegated change handler');
  check('saveAvailability parses capacity through parseCapacityInput', /parseCapacityInput\(/.test(saveFn));
  check('saveAvailability returns before the request when capacity is invalid',
    /if \(!cap\.ok\)\s*\{[\s\S]*?\breturn;\s*\}/.test(saveFn), saveFn.match(/if \(!cap\.ok\)[\s\S]{0,300}/)?.[0]);
  check('saveAvailability shows the validation message to the user (inline status)',
    /if \(!cap\.ok\)[\s\S]{0,400}textContent = cap\.error/.test(saveFn));
  check('saveAvailability payload uses cap.value for max_demos_per_slot',
    /const maxPerSlot = cap\.value;/.test(saveFn) && /max_demos_per_slot: maxPerSlot/.test(saveFn));
  check('saveAvailability no longer maps 0 to null', !/=== 0 \? null/.test(saveFn) && !/No limit/.test(saveFn));
  check('the "0 = No limit. Persist as null" comment is gone', !html.includes('0 = No limit'));
  void fn;
}

// 3. "Apply to all locations" uses the same rule.
{
  const applyFn = slice('async function applyScheduleToAllStores()', 'const _PLATFORM_FEE');
  check('applyScheduleToAllStores parses capacity through parseCapacityInput', /parseCapacityInput\(/.test(applyFn));
  check('applyScheduleToAllStores returns before any request when capacity is invalid',
    /if \(!cap\.ok\)\s*\{[\s\S]*?\breturn;\s*\}/.test(applyFn) && applyFn.indexOf('if (!cap.ok)') < applyFn.indexOf('adminUpdate('));
  check('applyScheduleToAllStores no longer silently coerces (Math.max(1, parseInt(...) || 1)) the capacity',
    !/Math\.max\(1,\s*parseInt\(maxInput/.test(applyFn));
  check('applyScheduleToAllStores payload uses cap.value', /const maxPerSlot = cap\.value;/.test(applyFn) && /max_demos_per_slot: maxPerSlot/.test(applyFn));
}

// 4. Anywhere in the page: max_demos_per_slot is never assigned null in a request body.
{
  const script = html.slice(html.indexOf('<script>'));
  check('no `max_demos_per_slot: null` anywhere in the page script', !/max_demos_per_slot:\s*null/.test(script));
  check('no ternary yields null for max_demos_per_slot', !/max_demos_per_slot:\s*[^,}\n]*\?\s*null/.test(script) && !/maxPerSlot\s*=\s*[^;\n]*\?\s*null/.test(script));
  check('legacy null/0 rows are displayed as 1 when loaded into the editor',
    /maxInput\.value = String\(Math\.max\(1, parseInt\(v\.max_demos_per_slot, 10\) \|\| 1\)\)/.test(script));
}

// 5. The input element: number, min=1, step=1, no "No limit" affordance or copy.
{
  const inputTag = html.match(/<(input|select)[^>]*id="availabilityMaxPerSlot"[^>]*>/);
  check('availabilityMaxPerSlot exists', !!inputTag);
  const tag = inputTag ? inputTag[0] : '';
  check('availabilityMaxPerSlot is an <input type="number">', /^<input/.test(tag) && /type="number"/.test(tag), tag.slice(0, 120));
  check('availabilityMaxPerSlot has min="1"', /\bmin="1"/.test(tag), tag);
  check('availabilityMaxPerSlot has step="1"', /\bstep="1"/.test(tag), tag);
  check('no min="0" on the capacity input', !/\bmin="0"/.test(tag));
  check('no <option value="0">No limit</option> remains', !/<option value="0">No limit<\/option>/.test(html));
  const noLimitMentions = (html.match(/No limit/g) || []).length;
  check('"No limit" copy is gone from labels/tooltips/help text', noLimitMentions === 0, `${noLimitMentions} mention(s)`);
  const tooltip = html.match(/for="availabilityMaxPerSlot"[^>]*>[\s\S]*?data-tooltip="([^"]*)"/);
  check('tooltip states the whole-number >= 1 rule', tooltip && /1 or more/i.test(tooltip[1]), tooltip && tooltip[1]);
  check('CSV column help states the whole-number >= 1 rule for max_demos_per_slot', /<strong>max_demos_per_slot<\/strong> \(whole number, 1 or more/.test(html));
}

// 6. CSV bulk import: invalid capacity → per-row error, row highlighted, import blocked.
{
  const parseLoop = slice("const rec = { name: '', address: '', demo_fee: 30, max_demos_per_slot: 1, active: true };", '_bulkParsedRows = parsed;');
  check('CSV row parse routes max_demos_per_slot through parseCapacityInput', /parseCapacityInput\(v\)/.test(parseLoop));
  check('CSV row parse no longer coerces with Math.max(1, parseInt(v, 10) || 1)', !/Math\.max\(1, parseInt\(v, 10\) \|\| 1\)/.test(parseLoop));
  check('CSV blank capacity still defaults to 1', /if \(!v\) rec\.max_demos_per_slot = 1;/.test(parseLoop));
  check('CSV invalid capacity marks the row and records the raw value', /rec\._capacityInvalid = true/.test(parseLoop) && /rec\._capacityRaw = v/.test(parseLoop));
  check('CSV invalid capacity pushes a per-row "Row N:" message following the existing errors[] pattern',
    /if \(rec\._capacityInvalid\) errors\.push\(`Row \$\{r\+1\}: max_demos_per_slot/.test(parseLoop));

  const preview = slice('function renderBulkPreview(parsed, errors)', 'async function importStoreCsv()');
  check('preview highlights rows with invalid capacity', /const invalid = !r\.name \|\| r\._capacityInvalid;/.test(preview));
  check('preview shows the raw invalid value (escaped) instead of a coerced 1', /escapeHtml\(r\._capacityRaw\)/.test(preview) && !/\$\{r\.max_demos_per_slot \|\| 1\}/.test(preview));
  check('import button is disabled while any row has invalid capacity',
    /const capacityBlocked = parsed\.some\(r => r\._capacityInvalid\);/.test(preview) && /btn\.disabled = validCount === 0 \|\| capacityBlocked;/.test(preview));

  // Simulate the row loop against the extracted parser: exactly the invalid rows are rejected.
  const rows = [['A', '1'], ['B', '0'], ['C', '-1'], ['D', 'abc'], ['E', '2'], ['F', '2.7'], ['G', '']];
  const results = rows.map(([name, v]) => {
    const rec = { name, max_demos_per_slot: 1 };
    if (!v) rec.max_demos_per_slot = 1;
    else { const cap = parseCapacityInput(v); if (cap.ok) rec.max_demos_per_slot = cap.value; else { rec._capacityRaw = v; rec._capacityInvalid = true; } }
    return rec;
  });
  const rejected = results.filter(r => r._capacityInvalid).map(r => r.name);
  check('CSV simulation rejects exactly rows with 0 / -1 / abc / 2.7', JSON.stringify(rejected) === JSON.stringify(['B', 'C', 'D', 'F']), rejected.join(','));
  check('CSV simulation accepts 1, 2 and blank(->1) with integer values',
    results.filter(r => !r._capacityInvalid).every(r => Number.isInteger(r.max_demos_per_slot) && r.max_demos_per_slot >= 1) &&
    results.find(r => r.name === 'E').max_demos_per_slot === 2 && results.find(r => r.name === 'G').max_demos_per_slot === 1);
  check('CSV simulation never yields null capacity', results.every(r => r.max_demos_per_slot !== null));
}

console.log(`\ncapacity input: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
