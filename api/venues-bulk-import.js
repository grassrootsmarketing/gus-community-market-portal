import { requireRetailerMembership } from './_retailer-auth.js';

// Tier limit enforcement — mirrors /api/admin
const TIER_LOCATION_LIMITS = { solo: 1, starter: 0, growth: 0, enterprise: 0 };
// /api/venues-bulk-import — POST FormData with a CSV file + session_id.
// Server parses CSV and inserts venues. Bypasses client-side file API hangs.

import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
let _b = null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

async function sb(path, opts = {}) {
  const headers = { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// (dead auth helper removed — all authorization goes through _retailer-auth.js)

// Simple CSV parser — quoted fields, escaped quotes, comma separators
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i+1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length-1].every(f => !f || !f.trim())) rows.pop();
  return rows;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/[\s_-]+/g, '');
}
const HEADER_ALIASES = {
  'name': 'name', 'storename': 'name', 'locationname': 'name', 'location': 'name', 'store': 'name',
  'address': 'address', 'streetaddress': 'address', 'fulladdress': 'address',
  'demofee': 'demo_fee', 'fee': 'demo_fee', 'price': 'demo_fee',
  'maxdemosperslot': 'max_demos_per_slot', 'capacity': 'max_demos_per_slot', 'maxdemos': 'max_demos_per_slot', 'maxperslot': 'max_demos_per_slot',
  'active': 'active', 'enabled': 'active', 'status': 'active',
};
function parseBoolish(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['', 'true', 'yes', 'y', '1', 'active', 'on'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'inactive', 'paused', 'off'].includes(s)) return false;
  return true;
}

// Codex FC-03: server-side mirror of parseCapacityInput() in r/gus/admin/index.html.
// venues.max_demos_per_slot is integer NOT NULL CHECK (>= 1). The old rule here was
// Math.max(1, parseInt(v, 10) || 1), which silently turned '0', '-1', 'abc' and '2.7' into 1 or 2 --
// a client that bypassed the browser-side check could import any garbage and get a venue.
// Rule: an absent column or a BLANK cell defaults to 1 (the column default). A supplied value is
// accepted ONLY when it is a base-10 whole integer >= 1 within PostgreSQL integer range:
//   /^[0-9]+$/ after trim, then 1 <= n <= 2147483647.
// Rejected, never coerced: '+3', '-1', '2.7', '1.0', '1e2', 'abc', 'NaN', '0', '2147483648'.
const PG_INT_MAX = 2147483647;
const CAPACITY_RE = /^[0-9]+$/;
export function parseCapacityStrict(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, value: 1, defaulted: true };
  if (!CAPACITY_RE.test(s)) {
    return { ok: false, message: `max_demos_per_slot must be a whole number of 1 or more (got "${s.slice(0, 40)}").` };
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, message: `max_demos_per_slot must be at least 1 (got "${s.slice(0, 40)}"). There is no "no limit" setting.` };
  }
  if (n > PG_INT_MAX) {
    return { ok: false, message: `max_demos_per_slot is too large (got "${s.slice(0, 40)}"; maximum is ${PG_INT_MAX}).` };
  }
  return { ok: true, value: n };
}

// Multipart/form-data parser for a single file field.
// Returns { csv_text, filename } or throws.
async function parseFormData(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();

  // Read body as Buffer
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  // Split by boundary
  const bodyStr = buffer.toString('latin1'); // preserves bytes
  const parts = bodyStr.split(boundary);
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n') continue;
    const headerBodySplit = part.indexOf('\r\n\r\n');
    if (headerBodySplit < 0) continue;
    const headerBlock = part.slice(0, headerBodySplit);
    let body = part.slice(headerBodySplit + 4);
    // Trim trailing \r\n before boundary
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    // Only care about the CSV file field
    if (!/Content-Disposition:.*name="?(csv|file)"?/i.test(headerBlock)) continue;
    const filenameMatch = headerBlock.match(/filename=(?:"([^"]+)"|([^;\r\n]+))/i);
    const filename = filenameMatch ? (filenameMatch[1] || filenameMatch[2]).trim() : 'upload.csv';
    // Convert latin1-decoded body back to a proper UTF-8 string via Buffer
    const bodyBuf = Buffer.from(body, 'latin1');
    const csvText = bodyBuf.toString('utf-8');
    return { csv_text: csvText, filename };
  }
  throw new Error('No CSV file field found in request');
}

function jsonResp(res, code, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(code).send(JSON.stringify(body));
}

export const config = {
  api: {
    bodyParser: false, // we parse multipart manually
  },
};

// DH-01: viewer-role staff accounts are read-only. Fail-open on lookup error (no viewer
// accounts exist yet; failing closed would risk locking out the owner).
// (dead auth helper removed — all authorization goes through _retailer-auth.js)

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  // Codex finding B, CSRF wiring: this route bulk-inserts venues for the caller's retailer from an uploaded CSV.
  // Checked before the session is read. No exemption applies — this route is cookie-authenticated
  // and carries neither a Stripe signature nor a CRON_SECRET.
  if (!requireSameOrigin(req, res, _b)) return;

  const _auth = await requireRetailerMembership(req, {}, null, ['owner', 'admin']);
  if (!_auth.ok) return jsonResp(res, _auth.status, { error: _auth.error });
  const session = { retailer_id: _auth.retailer_id, email: _auth.email };

  let csvText, filename;
  try {
    const parsed = await parseFormData(req);
    csvText = parsed.csv_text;
    filename = parsed.filename;
  } catch (e) {
    return jsonResp(res, 400, { error: 'Multipart parse failed: ' + (e.message || String(e)) });
  }

  if (!csvText || !csvText.trim()) {
    return jsonResp(res, 400, { error: 'CSV file was empty' });
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    return jsonResp(res, 400, { error: 'CSV needs a header row + at least one data row' });
  }

  const rawHeaders = rows[0].map(normalizeHeader);
  const columnMap = rawHeaders.map(h => HEADER_ALIASES[h] || null);
  if (!columnMap.includes('name')) {
    return jsonResp(res, 400, { error: 'No "name" column found. Rename your first column to "name" (or "location", "store name").' });
  }

  // ===== Codex FC-03: validate EVERY row before any insert. =====
  // A single invalid cell rejects the whole file with 400 invalid_rows and ZERO inserts -- the
  // client can fix the CSV and re-upload without half a file already imported. `row` is the
  // 1-based CSV DATA row (header excluded); `line` is the physical line in the file.
  const parsedRows = [];
  const errors = [];
  for (let r = 1; r < rows.length; r++) {
    const rec = {
      name: '',
      address: null,
      demo_fee: 30,
      max_demos_per_slot: 1,
      active: true,
      // Seed the standard 11-2 + 3-6 windows on all 7 days by default so bulk-imported
      // venues are immediately bookable. Retailer can toggle days off in the admin.
      availability: {
        schedule: {
          '0': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '1': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '2': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '3': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '4': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '5': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
          '6': [{ open: '11:00', close: '14:00' }, { open: '15:00', close: '18:00' }],
        },
        blackouts: [],
      },
    };
    for (let c = 0; c < rows[r].length; c++) {
      const col = columnMap[c];
      if (!col) continue;
      const v = (rows[r][c] || '').trim();
      if (col === 'demo_fee') rec.demo_fee = v ? Number(v.replace(/[$,]/g, '')) : 30;
      else if (col === 'max_demos_per_slot') {
        const cap = parseCapacityStrict(v);
        if (!cap.ok) { errors.push({ row: r, line: r + 1, field: 'max_demos_per_slot', message: cap.message }); rec.max_demos_per_slot = null; }
        else rec.max_demos_per_slot = cap.value;
      }
      else if (col === 'active') rec.active = parseBoolish(v);
      else if (col === 'address') rec.address = v || null;
      else rec[col] = v;
    }
    if (!rec.name) errors.push({ row: r, line: r + 1, field: 'name', message: 'name is required.' });
    if (!Number.isFinite(rec.demo_fee) || rec.demo_fee < 0) errors.push({ row: r, line: r + 1, field: 'demo_fee', message: 'demo_fee must be a non-negative number.' });
    parsedRows.push({ rec, row: r });
  }

  if (errors.length > 0) {
    return jsonResp(res, 400, {
      ok: false,
      error: 'invalid_rows',
      message: `${errors.length} invalid value${errors.length === 1 ? '' : 's'} found. Nothing was imported -- fix the CSV and upload it again.`,
      errors,
      imported: 0,
      total: parsedRows.length,
      filename,
    });
  }
  if (parsedRows.length === 0) {
    return jsonResp(res, 400, { ok: false, error: 'no_rows', message: 'No data rows to import.', errors: [], imported: 0, total: 0, filename });
  }

  // ===== Tier precheck: cap total venues after this import (friendly 402 before any write). =====
  // Codex FC-03: this used to log the lookup error and PROCEED. It now fails closed -- if the
  // entitlement cannot be read, nothing is inserted. The DB trigger enforce_venue_limit() remains
  // the authoritative guard (FOR UPDATE serialised); this is only the early, friendly refusal.
  try {
    const rArr = await sb(`retailers?id=eq.${encodeURIComponent(session.retailer_id)}&select=billing_tier`);
    if (!Array.isArray(rArr) || !rArr[0]) throw new Error('retailer_not_found');
    const tier = String(rArr[0].billing_tier || 'solo').toLowerCase();
    const limit = TIER_LOCATION_LIMITS[tier] || 0;
    if (limit > 0) {
      const existingArr = await sb(`venues?retailer_id=eq.${encodeURIComponent(session.retailer_id)}&select=id`);
      if (!Array.isArray(existingArr)) throw new Error('venue_count_unavailable');
      const existingCount = existingArr.length;
      const proposedTotal = existingCount + parsedRows.length;
      if (proposedTotal > limit) {
        return jsonResp(res, 402, {
          ok: false,
          error: 'plan_limit_reached',
          message: `Your ${tier} plan is limited to ${limit} location${limit === 1 ? '' : 's'}. This import would create ${proposedTotal}. Upgrade to import more.`,
          tier, limit, existing: existingCount, upgrade_url: '/pricing', imported: 0, total: parsedRows.length,
        });
      }
    }
  } catch (e) {
    console.error('bulk-import entitlement precheck unavailable:', e?.message || e);
    return jsonResp(res, 503, { ok: false, error: 'entitlement_unavailable', message: 'Could not verify your plan. Nothing was imported -- try again in a moment.', imported: 0, total: parsedRows.length });
  }

  // ===== Insert each venue. Stop at the FIRST database refusal. =====
  // enforce_venue_limit() raises 'venue_limit_reached' (check_violation) on the insert that
  // would exceed the plan; every later row would fail the same way, so continuing only burns
  // requests. The response is non-2xx with the EXACT number of rows that were inserted before
  // the failure -- never ok:true on a partial import.
  let imported = 0;
  for (const { rec, row } of parsedRows) {
    try {
      await sb('venues', {
        method: 'POST',
        body: JSON.stringify({ ...rec, retailer_id: session.retailer_id }),
      });
      imported++;
    } catch (e) {
      const detail = String(e?.message || e || '');
      const limitHit = /venue_limit_reached/i.test(detail);
      console.error('bulk-import insert failed at row', row, limitHit ? 'venue_limit_reached' : detail.slice(0, 200));
      const message = limitHit
        ? "Your plan's location limit was reached at this row. Upgrade to import more locations."
        : 'The database rejected this row.';
      const failure = { row, line: row + 1, name: rec.name, message };
      return jsonResp(res, limitHit ? 409 : 500, {
        ok: false,
        error: limitHit ? 'venue_limit_reached' : 'insert_failed',
        message: `Imported ${imported} of ${parsedRows.length} location${parsedRows.length === 1 ? '' : 's'} before row ${row} was refused.`,
        imported,
        failed: parsedRows.length - imported,
        total: parsedRows.length,
        errors: [failure],
        parse_errors: [],
        insert_errors: [`Row ${failure.row} (${failure.name}): ${failure.message}`],
        filename,
      });
    }
  }

  return jsonResp(res, 200, {
    ok: true,
    imported,
    total: parsedRows.length,
    parse_errors: [],
    insert_errors: [],
    filename,
  });
}
