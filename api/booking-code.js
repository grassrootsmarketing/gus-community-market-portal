// api/booking-code.js — preview what a booking code would do at this store (0085). Read-only: never redeems or
// counts. Requires the brand session so anonymous visitors cannot probe codes; the booking page calls it when the
// brand presses "Apply" so the price and the calendar can update before /api/book runs the real check again.
import { requireBrandSession } from './_booking-identity.js';
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { normalizeCode, CODE_MESSAGES, KIND_LABELS, kindOf } from './_booking-codes.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let b; try { b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  if (!requireSameOrigin(req, res, b)) return;
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const H = { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json' };
  const rr = await fetch(`${b.supabaseUrl}/rest/v1/retailers?slug=eq.${encodeURIComponent(String(body.retailer_slug || ''))}&select=id`, { headers: H });
  const retailer = rr.ok ? (await rr.json())[0] : null;
  if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
  const norm = normalizeCode(body.code);
  if (!norm) return res.status(400).json({ error: 'code_invalid_format', message: CODE_MESSAGES.code_invalid_format });
  const r = await fetch(`${b.supabaseUrl}/rest/v1/rpc/booking_code_check`, { method: 'POST', headers: H, body: JSON.stringify({ p_code: norm, p_retailer_id: retailer.id }) });
  if (!r.ok) return res.status(503).json({ error: 'code_check_unavailable' });
  const j = await r.json(); const chk = Array.isArray(j) ? j[0] : j;
  if (!chk || !chk.ok) { const reason = (chk && chk.reason) || 'code_not_found'; return res.status(400).json({ error: reason, message: CODE_MESSAGES[reason] || CODE_MESSAGES.code_not_found }); }
  const kind = kindOf(chk);
  return res.status(200).json({ ok: true, code: norm, waives_fee: !!chk.waives_fee, waives_lead_time: !!chk.waives_lead_time, kind, label: KIND_LABELS[kind] });
}
