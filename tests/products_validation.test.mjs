// tests/products_validation.test.mjs — Codex product-list P-2: the shared item validator (api/_products.js), no database.
import { validateProducts, describeErrors, describeItem, itemDetailsHtml, LIMITS, newItemId } from '../api/_products.js';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; fails.push(n + ' ' + x); console.log('  FAIL ' + n + ' ' + x); } };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const codes = (r) => (r.errors || []).map(e => `${e.index}:${e.field}:${e.code}`);
const base = { name: 'Lime Fizz', size: '12 oz', sku: 'LF-12', upc: '0 12345-67890 5', distributor: 'unfi', distributor_item_number: '0001234', case_pack: 12, notes: 'ships chilled' };

console.log('\n— shape and normalisation —');
{
  const r = validateProducts([base], 'catalog');
  ok('a full valid item passes', r.ok, JSON.stringify(r));
  const it = r.items[0];
  ok('UPC keeps only digits and leading zeros ("0 12345-67890 5" -> "012345678905")', it.upc === '012345678905', it.upc);
  ok('an id is generated when missing, bounded and url-safe', typeof it.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(it.id));
  ok('text is trimmed, enum kept, integer kept, distributor_other cleared when not other', it.name === 'Lime Fizz' && it.distributor === 'unfi' && it.case_pack === 12 && it.distributor_other === '');
  ok('exactly the canonical fields come back', Object.keys(it).sort().join() === ['id', 'name', 'size', 'sku', 'upc', 'distributor', 'distributor_other', 'distributor_item_number', 'case_pack', 'notes'].sort().join(), Object.keys(it).join());
  const r2 = validateProducts([{ ...base, id: 'keep-me', extra: 'dropped', nested: { a: 1 } }], 'catalog');
  ok('a valid id is preserved and unknown keys are dropped', r2.ok && r2.items[0].id === 'keep-me' && !('extra' in r2.items[0]) && !('nested' in r2.items[0]));
  const r3 = validateProducts([{ name: '  Plain  ' }], 'catalog');
  ok('name-only item: optional fields normalise to empty / null', r3.ok && r3.items[0].name === 'Plain' && r3.items[0].upc === '' && r3.items[0].case_pack === null && r3.items[0].distributor === '');
  ok('legacy {name,size,sku} validates unchanged', validateProducts([{ name: 'Old', size: '1 lb', sku: 'X' }], 'booking').ok);
}

console.log('\n— rejections are explicit (never silent drop or truncate) —');
{
  ok('not a list', codes(validateProducts({}, 'catalog')).join() === '-1:items:not_a_list');
  ok('booking: empty list is required', codes(validateProducts([], 'booking')).join() === '-1:items:required');
  ok('catalog: empty list is allowed', validateProducts([], 'catalog').ok);
  ok('booking: 41 items too many', codes(validateProducts(Array.from({ length: 41 }, (_, i) => ({ name: 'n' + i })), 'booking')).join() === '-1:items:too_many');
  ok('booking: 40 items ok', validateProducts(Array.from({ length: 40 }, (_, i) => ({ name: 'n' + i })), 'booking').ok);
  ok('catalog: 61 items too many; 60 ok', !validateProducts(Array.from({ length: 61 }, (_, i) => ({ name: 'n' + i })), 'catalog').ok && validateProducts(Array.from({ length: 60 }, (_, i) => ({ name: 'n' + i })), 'catalog').ok);
  ok('item that is not an object', codes(validateProducts(['x'], 'catalog')).join() === '0:item:not_an_object');
  ok('blank name is required', codes(validateProducts([{ name: '   ' }], 'catalog')).join() === '0:name:required');
  ok('name too long is rejected, not truncated', codes(validateProducts([{ name: 'x'.repeat(121) }], 'catalog')).join() === '0:name:too_long');
  ok('object as name is not_text (no [object Object])', codes(validateProducts([{ name: { a: 1 } }], 'catalog')).join() === '0:name:not_text');
  ok('boolean as size is not_text', codes(validateProducts([{ name: 'n', size: true }], 'catalog')).join() === '0:size:not_text');
  ok('numeric UPC is refused (leading zeros already lost)', codes(validateProducts([{ name: 'n', upc: 12345678 }], 'catalog')).join() === '0:upc:not_text');
  ok('UPC with letters', codes(validateProducts([{ name: 'n', upc: '0123ABC45678' }], 'catalog')).join() === '0:upc:not_digits');
  ok('UPC wrong length (11)', codes(validateProducts([{ name: 'n', upc: '01234567890' }], 'catalog')).join() === '0:upc:bad_length');
  ok('UPC lengths 8/12/13/14 accepted', [8, 12, 13, 14].every(n => validateProducts([{ name: 'n', upc: '1'.repeat(n) }], 'catalog').ok));
  ok('distributor outside the enum', codes(validateProducts([{ name: 'n', distributor: 'Sysco' }], 'catalog')).join() === '0:distributor:invalid');
  ok('other without a name is required', codes(validateProducts([{ name: 'n', distributor: 'other' }], 'catalog')).join() === '0:distributor_other:required');
  ok('other with a name passes and keeps it', (() => { const r = validateProducts([{ name: 'n', distributor: 'other', distributor_other: ' Pod Foods ' }], 'catalog'); return r.ok && r.items[0].distributor_other === 'Pod Foods'; })());
  ok('distributor_other is cleared when the distributor is not other', validateProducts([{ name: 'n', distributor: 'kehe', distributor_other: 'stale' }], 'catalog').items[0].distributor_other === '');
  ok('item number keeps leading zeros and punctuation', validateProducts([{ name: 'n', distributor_item_number: '00123-A/7' }], 'catalog').items[0].distributor_item_number === '00123-A/7');
  ok('case_pack as a string is refused (no coercion)', codes(validateProducts([{ name: 'n', case_pack: '12' }], 'catalog')).join() === '0:case_pack:not_integer');
  ok('case_pack fractional is refused', codes(validateProducts([{ name: 'n', case_pack: 12.5 }], 'catalog')).join() === '0:case_pack:not_integer');
  ok('case_pack 0 and 1000 out of range; 1 and 999 ok', codes(validateProducts([{ name: 'n', case_pack: 0 }], 'catalog')).join() === '0:case_pack:out_of_range' && codes(validateProducts([{ name: 'n', case_pack: 1000 }], 'catalog')).join() === '0:case_pack:out_of_range' && validateProducts([{ name: 'n', case_pack: 1 }, { name: 'm', case_pack: 999 }], 'catalog').ok);
  ok('notes too long rejected', codes(validateProducts([{ name: 'n', notes: 'x'.repeat(201) }], 'catalog')).join() === '0:notes:too_long');
  ok('malformed id rejected', codes(validateProducts([{ name: 'n', id: 'has space' }], 'catalog')).join() === '0:id:invalid');
  ok('duplicate ids rejected (second occurrence named)', codes(validateProducts([{ id: 'a', name: 'n' }, { id: 'a', name: 'm' }], 'catalog')).join() === '1:id:duplicate');
  ok('several bad fields on one item all reported', codes(validateProducts([{ name: '', upc: 'x', case_pack: '3' }], 'catalog')).length === 3);
  ok('describeErrors is bounded and names item, field and problem', /item 1 name is required/.test(describeErrors([{ index: 0, field: 'name', code: 'required' }])) && describeErrors(Array.from({ length: 20 }, (_, i) => ({ index: i, field: 'name', code: 'required' }))).split(';').length === 5);
  ok('LIMITS exported as expected', LIMITS.catalog === 60 && LIMITS.booking === 40 && LIMITS.name === 120 && LIMITS.notes === 200);
  ok('newItemId is unique and well-formed', newItemId() !== newItemId() && /^p_[A-Za-z0-9_-]+$/.test(newItemId()));
}

console.log('\n— rendering is tolerant and escaped —');
{
  const hostile = { name: '<img src=x onerror=alert(1)>', size: '"q"', sku: '<b>', upc: '012345678905', distributor: 'other', distributor_other: '<i>Pod</i>', distributor_item_number: '<u>1</u>', case_pack: 6, notes: '<script>' };
  const line = describeItem(hostile, esc); const full = itemDetailsHtml(hostile, esc);
  ok('compact line escapes name, size and sku', !/<img|<b>/.test(line) && /&lt;img/.test(line) && /brand SKU &lt;b&gt;/.test(line));
  ok('full details escape every field and label the barcode, distributor, item number, case pack and brand SKU', !/<img|<i>Pod|<u>1|<script>/.test(full) && /UPC \/ product barcode/.test(full) && /&lt;i&gt;Pod/.test(full) && /6 units per case/.test(full) && /Brand SKU/.test(full));
  const legacy = itemDetailsHtml({ name: 'Old', size: '1 lb', sku: 'X' }, esc);
  ok('legacy item renders with "Not provided" for absent ordering fields', (legacy.match(/Not provided/g) || []).length === 4 && /Brand SKU:<\/span> X/.test(legacy));
  ok('empty / junk items render as empty strings, not throws', describeItem(null, esc) === '' && describeItem('x', esc) === '');
}

console.log(`\nproducts validation: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
