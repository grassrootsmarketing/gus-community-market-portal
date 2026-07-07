// /api/venues-bulk-import — POST FormData with a CSV file + session_id.
// Server parses CSV and inserts venues. Bypasses client-side file API hangs.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

async function verifySession(sessionId) {
  if (!isUuid(sessionId)) return null;
  try {
    const sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*`);
    const s = Array.isArray(sessions) ? sessions[0] : null;
    if (!s) return null;
    if (new Date(s.expires_at).getTime() < Date.now()) return null;
    return { retailer_id: s.retailer_id, email: s.email };
  } catch { return null; }
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return jsonResp(res, 405, { error: 'POST only' });

  const sessionId = (req.query?.session_id || '').toString();
  const session = await verifySession(sessionId);
  if (!session) return jsonResp(res, 401, { error: 'Invalid session' });
  if (!session.retailer_id) return jsonResp(res, 403, { error: 'Session has no retailer_id' });

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

  // Parse each data row into a venue payload
  const parsedRows = [];
  const errors = [];
  for (let r = 1; r < rows.length; r++) {
    const rec = { name: '', address: null, demo_fee: 30, max_demos_per_slot: 1, active: true };
    for (let c = 0; c < rows[r].length; c++) {
      const col = columnMap[c];
      if (!col) continue;
      const v = (rows[r][c] || '').trim();
      if (col === 'demo_fee') rec.demo_fee = v ? Number(v.replace(/[$,]/g, '')) : 30;
      else if (col === 'max_demos_per_slot') rec.max_demos_per_slot = v ? Math.max(1, parseInt(v, 10) || 1) : 1;
      else if (col === 'active') rec.active = parseBoolish(v);
      else if (col === 'address') rec.address = v || null;
      else rec[col] = v;
    }
    if (!rec.name) { errors.push(`Row ${r+1}: name is required`); continue; }
    if (isNaN(rec.demo_fee)) { errors.push(`Row ${r+1}: demo_fee "${rec.demo_fee}" is not a number`); continue; }
    parsedRows.push({ rec, row: r + 1 });
  }

  if (parsedRows.length === 0) {
    return jsonResp(res, 400, { error: 'No valid rows to import', errors });
  }

  // Insert each venue
  let imported = 0;
  const insertErrors = [];
  for (const { rec, row } of parsedRows) {
    try {
      await sb('venues', {
        method: 'POST',
        body: JSON.stringify({ ...rec, retailer_id: session.retailer_id }),
      });
      imported++;
    } catch (e) {
      insertErrors.push(`Row ${row} (${rec.name}): ${e.message || String(e)}`);
    }
  }

  return jsonResp(res, 200, {
    ok: true,
    imported,
    total: parsedRows.length,
    parse_errors: errors,
    insert_errors: insertErrors,
    filename,
  });
}
