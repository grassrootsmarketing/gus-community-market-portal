// api/_products.js — the ONE validator for brand product items (Codex product-list review P-2, 2026-10-07).
//
// Two writers share it: the brand profile catalog (api/brand-account.js profile-update, mode 'catalog', up to 60
// items) and the booking snapshot (api/book.js, mode 'booking', 1 to 40 items). Historical rows are NOT passed
// through it: rendering (renderItemsHtml / describeItem) is tolerant of the legacy {name,size,sku} shape and of
// missing fields; validation is for writes only.
//
// Canonical item:
//   id                       stable, bounded, unique within a list; preserved when valid, generated server-side
//   name                     required, 1..120 after trim
//   size                     optional, <= 40: the individual unit ("12 oz jar")
//   sku                      optional, <= 60: the BRAND's own code (kept visibly distinct from the distributor's)
//   upc                      optional: 8, 12, 13 or 14 digits after removing spaces and hyphens only; stored as a
//                            string so leading zeros survive. This is FORMAT validation, not proof of a real barcode.
//   distributor              optional enum: unfi | kehe | direct | other
//   distributor_other        required (<= 60) when distributor is 'other'; cleared otherwise
//   distributor_item_number  optional, <= 40, text (leading zeros and punctuation preserved)
//   case_pack                optional integer 1..999: sellable units in ONE case (not cases to order)
//   notes                    optional, <= 200 (shared with the booked retailer's contacts, like every other field)
//
// Rules: typed fields only (no object/array/boolean coercion into text, no number-to-identifier for UPC);
// unknown keys dropped; invalid KNOWN fields are rejected with {index, field, code}, never silently dropped or
// truncated; empty optional values are allowed and normalised to ''.

import crypto from 'node:crypto';

export const LIMITS = Object.freeze({
  catalog: 60, booking: 40,
  name: 120, size: 40, sku: 60, distributor_other: 60, distributor_item_number: 40, notes: 200, id: 40,
  case_pack_min: 1, case_pack_max: 999,
});
export const DISTRIBUTORS = Object.freeze(['unfi', 'kehe', 'direct', 'other']);
export const DISTRIBUTOR_LABELS = Object.freeze({ unfi: 'UNFI', kehe: 'KeHE', direct: 'Direct from the brand', other: 'Other' });
export const UPC_LENGTHS = Object.freeze([8, 12, 13, 14]);
export const FIELDS = Object.freeze(['id', 'name', 'size', 'sku', 'upc', 'distributor', 'distributor_other', 'distributor_item_number', 'case_pack', 'notes']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export function newItemId() { return 'p_' + crypto.randomBytes(9).toString('base64url'); }

// Text field: must be a string (or absent/null); trimmed; bounded. Returns { ok, value } or { ok:false, code }.
function text(v, max) {
  if (v === undefined || v === null) return { ok: true, value: '' };
  if (typeof v !== 'string') return { ok: false, code: 'not_text' };
  const t = v.trim();
  if (t.length > max) return { ok: false, code: 'too_long', max };
  return { ok: true, value: t };
}

// Validate one list. mode: 'catalog' | 'booking'. Returns { ok:true, items } or { ok:false, errors:[{index, field, code, ...}] }.
export function validateProducts(input, mode) {
  const max = mode === 'booking' ? LIMITS.booking : LIMITS.catalog;
  const errors = [];
  if (!Array.isArray(input)) return { ok: false, errors: [{ index: -1, field: 'items', code: 'not_a_list' }] };
  if (mode === 'booking' && input.length === 0) return { ok: false, errors: [{ index: -1, field: 'items', code: 'required' }] };
  if (input.length > max) return { ok: false, errors: [{ index: -1, field: 'items', code: 'too_many', max }] };
  const items = [];
  const seenIds = new Set();
  input.forEach((raw, index) => {
    const err = (field, code, extra) => errors.push({ index, field, code, ...(extra || {}) });
    if (!isPlainObject(raw)) { err('item', 'not_an_object'); return; }
    const out = {};
    // id: keep a valid one, generate a missing one, refuse a malformed or duplicate one
    if (raw.id === undefined || raw.id === null || raw.id === '') out.id = newItemId();
    else if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) { err('id', 'invalid'); }
    else out.id = raw.id;
    if (out.id) { if (seenIds.has(out.id)) err('id', 'duplicate'); else seenIds.add(out.id); }
    // name
    const name = text(raw.name, LIMITS.name);
    if (!name.ok) err('name', name.code, name.max ? { max: name.max } : undefined);
    else if (!name.value) err('name', 'required');
    else out.name = name.value;
    // simple text fields
    for (const [f, max] of [['size', LIMITS.size], ['sku', LIMITS.sku], ['distributor_item_number', LIMITS.distributor_item_number], ['notes', LIMITS.notes]]) {
      const t = text(raw[f], max);
      if (!t.ok) err(f, t.code, t.max ? { max: t.max } : undefined); else out[f] = t.value;
    }
    // upc: string only; strip spaces and hyphens; digits; allowed lengths
    if (raw.upc === undefined || raw.upc === null || raw.upc === '') out.upc = '';
    else if (typeof raw.upc !== 'string') err('upc', 'not_text');
    else {
      const digits = raw.upc.replace(/[\s-]/g, '');
      if (!/^\d+$/.test(digits)) err('upc', 'not_digits');
      else if (!UPC_LENGTHS.includes(digits.length)) err('upc', 'bad_length', { allowed: UPC_LENGTHS });
      else out.upc = digits;
    }
    // distributor enum + other text
    if (raw.distributor === undefined || raw.distributor === null || raw.distributor === '') out.distributor = '';
    else if (typeof raw.distributor !== 'string' || !DISTRIBUTORS.includes(raw.distributor)) err('distributor', 'invalid', { allowed: DISTRIBUTORS });
    else out.distributor = raw.distributor;
    const other = text(raw.distributor_other, LIMITS.distributor_other);
    if (!other.ok) err('distributor_other', other.code, other.max ? { max: other.max } : undefined);
    else if (out.distributor === 'other' && !other.value) err('distributor_other', 'required');
    else out.distributor_other = out.distributor === 'other' ? other.value : '';
    // case_pack: integer in range, no coercion
    if (raw.case_pack === undefined || raw.case_pack === null || raw.case_pack === '') out.case_pack = null;
    else if (typeof raw.case_pack !== 'number' || !Number.isInteger(raw.case_pack)) err('case_pack', 'not_integer');
    else if (raw.case_pack < LIMITS.case_pack_min || raw.case_pack > LIMITS.case_pack_max) err('case_pack', 'out_of_range', { min: LIMITS.case_pack_min, max: LIMITS.case_pack_max });
    else out.case_pack = raw.case_pack;
    items.push(out);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, items };
}

// Human-readable error for a 400 body (bounded, no echo of the offending value).
export function describeErrors(errors) {
  const words = { not_a_list: 'items must be a list', required: 'is required', too_many: 'too many items', not_an_object: 'is not an item', invalid: 'is not valid', duplicate: 'is repeated', not_text: 'must be text', too_long: 'is too long', not_digits: 'must contain only digits', bad_length: 'must have 8, 12, 13 or 14 digits', not_integer: 'must be a whole number', out_of_range: 'is out of range' };
  return (errors || []).slice(0, 5).map(e => (e.index >= 0 ? `item ${e.index + 1} ${e.field} ` : `${e.field} `) + (words[e.code] || e.code)).join('; ');
}

// ---------------------------------------------------------------------------
// Rendering helpers, tolerant of legacy items. `esc` is the caller's HTML escaper.
// ---------------------------------------------------------------------------
export function distributorLabel(item) {
  if (!item || !item.distributor) return '';
  if (item.distributor === 'other') return item.distributor_other || 'Other';
  return DISTRIBUTOR_LABELS[item.distributor] || String(item.distributor);
}
// One-line description: "Name (12 oz) · brand SKU ABC"
export function describeItem(item, esc) {
  const e = esc || ((s) => String(s));
  if (!item || typeof item !== 'object') return '';
  const parts = [e(item.name || '')];
  if (item.size) parts.push(' <span style="color:#6b6a64;">(' + e(item.size) + ')</span>');
  if (item.sku) parts.push(' <span style="color:#6b6a64;">brand SKU ' + e(item.sku) + '</span>');
  return parts.join('');
}
// Stacked ordering details for one item (full layout), absent optional details read "Not provided".
export function itemDetailsHtml(item, esc) {
  const e = esc || ((s) => String(s));
  const np = '<span style="color:#9a978f;">Not provided</span>';
  const line = (k, v) => `<div style="font-size:13px;line-height:1.5;"><span style="color:#6b6a64;">${k}:</span> ${v || np}</div>`;
  const cp = Number.isInteger(item.case_pack) ? `${item.case_pack} unit${item.case_pack === 1 ? '' : 's'} per case` : '';
  return `<div style="padding:10px 0;border-top:1px solid #ede3d0;">
<div style="font-size:15px;font-weight:700;color:#1c1c1a;">${e(item.name || '')}${item.size ? ` <span style="font-weight:400;color:#6b6a64;">(${e(item.size)})</span>` : ''}</div>
${line('UPC / product barcode', item.upc ? e(item.upc) : '')}
${line('Distributor', distributorLabel(item) ? e(distributorLabel(item)) : '')}
${line('Distributor item number', item.distributor_item_number ? e(item.distributor_item_number) : '')}
${line('Case pack', cp ? e(cp) : '')}
${line('Brand SKU', item.sku ? e(item.sku) : '')}
${item.notes ? line('Notes', e(item.notes)) : ''}
</div>`;
}
