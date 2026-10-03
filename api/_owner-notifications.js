// api/_owner-notifications.js — owner Notifications panel reads (Codex N-1, design review 2026-10-03).
//
// READ-ONLY. Three owner-authenticated actions in api/admin-auth.js call into here:
//   owner-notifications          one bounded, paginated LIST of deliveries: scheduled | overdue | attention | accepted
//   owner-notifications-summary  exact counts for the four lists + notification-worker health
//   owner-booking-notifications  everything recorded for ONE booking: deliveries (every status), events, facts
//
// Rules this module keeps (Codex N-1):
//   * Explicit output fields only. Never frozen_payload, idempotency_key, claim_token, provider_message_id,
//     verification data or raw last_error. Errors are mapped to the allowlisted codes in ERROR_CODES.
//   * "accepted" means ACCEPTED BY THE EMAIL PROVIDER, nothing more. The only timestamp shown for it is the row's
//     recorded updated_at, which the worker stamps when it records the acceptance and never touches again.
//   * The lists are defined on UTC instants, from the server's clock at request time:
//       scheduled  status pending, due_at in [now, now + days*24h)
//       overdue    actionable work the worker has not finished: pending with due_at < now; claimed whose lease
//                  has expired; failed with a retry time set (next_attempt_at not null), regardless of age
//       attention  failed with no retry (terminal) and unknown, regardless of age (old unknowns never vanish)
//       accepted   accepted with updated_at >= now - days*24h
//     "days" (1..31, default 14) is a count of 24-hour periods from now, not calendar days in any timezone.
//   * Deterministic order and pagination: due_at asc, id asc (accepted/attention: updated_at desc, id asc);
//     limit 1..500 (default 200), offset 0..100000; total and complete come from the exact count.
//     Server-side retailer filtering is a query predicate, applied before the page is cut.
//   * Enrichment (booking, retailer, venue, contact name) is read for the ids on THIS page only, so it is bounded;
//     any enrichment read that fails is reported in `partial` and the row keeps its ids. A failed REQUIRED read
//     throws, and the route answers 503 with retry:true, never an empty panel.
//   * Each row carries the store's timezone so the UI can display the time in it with a label. Nothing here is
//     formatted in the owner's browser timezone.
//   * Counts in the booking view are stated two ways: reminder TIMES (distinct offsets) and recipient EMAILS.
//     They are computed per occurrence (schedule revision) and exclude skipped rows unless stated.
//   * No reason is guessed for an empty booking: the facts recorded (booking status, events, fan-out, lookahead,
//     worker health) are returned and the UI shows them as facts.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

export const LISTS = Object.freeze(['scheduled', 'overdue', 'attention', 'accepted']);
export const DEFAULT_DAYS = 14, MIN_DAYS = 1, MAX_DAYS = 31;
export const DEFAULT_LIMIT = 200, MAX_LIMIT = 500, MAX_OFFSET = 100000;
// The worker's reminder lookahead (api/_notification-outbox.js schedules confirmed demos up to this far ahead).
export const SCHEDULING_LOOKAHEAD_DAYS = 31;
// The worker runs every 15 minutes in production; a last success older than this is reported as stale.
export const WORKER_STALE_MINUTES = 35;

// Allowlisted public reason codes. Anything not recognised is 'other'; the raw string never leaves the server.
export const ERROR_CODES = Object.freeze(['provider_rejected', 'provider_unreachable', 'provider_ack_unverified', 'provider_not_configured', 'idempotency_window_expired', 'review_required', 'max_attempts', 'recipient_changed', 'settings_unreadable', 'send_failed', 'other']);
export function publicErrorCode(lastError) {
  const s = String(lastError || '').toLowerCase();
  if (!s) return null;
  if (s.startsWith('idempotency_window_expired')) return 'idempotency_window_expired';
  if (s.startsWith('review_required')) return 'review_required';
  if (s.startsWith('mail_provider_unreachable')) return 'provider_unreachable';
  if (s.startsWith('mail_ack_unverified')) return 'provider_ack_unverified';
  if (s.startsWith('mail_provider_not_configured')) return 'provider_not_configured';
  if (s.startsWith('mail_send_failed') || s.startsWith('mail_rejected') || s.startsWith('provider_')) return 'provider_rejected';
  if (s.startsWith('max_attempts')) return 'max_attempts';
  if (s.startsWith('recipient_')) return 'recipient_changed';
  if (s.startsWith('settings_read') || s.startsWith('store_defaults') || s.startsWith('prefs_')) return 'settings_unreadable';
  if (s.startsWith('send_failed')) return 'send_failed';
  return 'other';
}

// Input validation shared by the three actions. Returns { ok:false, error } or the parsed values.
export function parseListInput(body) {
  const b = body || {};
  const list = String(b.list || 'scheduled');
  if (!LISTS.includes(list)) return { ok: false, error: 'list must be one of ' + LISTS.join(', ') };
  const rid = b.retailer_id == null || b.retailer_id === '' ? null : b.retailer_id;
  if (rid !== null && !isUuid(rid)) return { ok: false, error: 'bad retailer_id' };
  const days = b.days == null || b.days === '' ? DEFAULT_DAYS : Number(b.days);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) return { ok: false, error: `days must be an integer ${MIN_DAYS}..${MAX_DAYS}` };
  const limit = b.limit == null || b.limit === '' ? DEFAULT_LIMIT : Number(b.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, error: `limit must be an integer 1..${MAX_LIMIT}` };
  const offset = b.offset == null || b.offset === '' ? 0 : Number(b.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return { ok: false, error: `offset must be an integer 0..${MAX_OFFSET}` };
  return { ok: true, list, retailer_id: rid, days, limit, offset };
}

// UTC window for the request, computed once so every read in the response agrees.
export function windowFor(days, now = new Date()) {
  const from = now.toISOString();
  return { now: from, from, to: new Date(now.getTime() + days * 864e5).toISOString(), since: new Date(now.getTime() - days * 864e5).toISOString(), days, semantics: `${days} x 24 hours from the server clock, UTC instants` };
}

const DELIVERY_COLS = 'id,event_id,retailer_id,booking_id,recipient_kind,recipient_id,recipient_email,kind,offset_key,occurrence_key,status,attempts,due_at,expires_at,next_attempt_at,lease_until,skip_reason,last_error,provider_message_id,created_at,updated_at';

// PostgREST filter + order for each list. `w` is windowFor(); rid is the optional retailer predicate.
export function listQuery(list, w, rid) {
  const r = rid ? `&retailer_id=eq.${encodeURIComponent(rid)}` : '';
  const base = `notification_deliveries?select=${DELIVERY_COLS}${r}`;
  if (list === 'scheduled') return `${base}&status=eq.pending&due_at=gte.${encodeURIComponent(w.from)}&due_at=lt.${encodeURIComponent(w.to)}&order=due_at.asc,id.asc`;
  if (list === 'overdue') return `${base}&or=(and(status.eq.pending,due_at.lt.${encodeURIComponent(w.now)}),and(status.eq.claimed,lease_until.lt.${encodeURIComponent(w.now)}),and(status.eq.failed,next_attempt_at.not.is.null))&order=due_at.asc,id.asc`;
  if (list === 'attention') return `${base}&or=(and(status.eq.failed,next_attempt_at.is.null),status.eq.unknown)&order=updated_at.desc,id.asc`;
  if (list === 'accepted') return `${base}&status=eq.accepted&updated_at=gte.${encodeURIComponent(w.since)}&order=updated_at.desc,id.asc`;
  throw new Error('unknown list');
}

// One page of a PostgREST query with the exact total. Throws on failure (the caller answers 503).
export async function sbPage(b, path, offset, limit) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: `${offset}-${offset + limit - 1}` } });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok && r.status !== 416) throw new Error(json?.message || text || `HTTP ${r.status}`);
  const total = Number(String(r.headers.get('content-range') || '').split('/')[1]);
  if (!Number.isFinite(total)) throw new Error('no exact count in response');
  const rows = Array.isArray(json) ? json : [];
  return { rows, total, complete: offset + rows.length >= total };
}
// Exact count only (no rows).
export async function sbCount(b, path) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } });
  if (!r.ok && r.status !== 416) throw new Error((await r.text()).slice(0, 200) || `HTTP ${r.status}`);
  const total = Number(String(r.headers.get('content-range') || '').split('/')[1]);
  if (!Number.isFinite(total)) throw new Error('no exact count in response');
  return total;
}
async function sbRows(b, path) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
  const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok || !Array.isArray(json)) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}
const inList = (ids) => ids.map(encodeURIComponent).join(',');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function byIds(b, table, ids, cols) {
  const m = new Map(); const uniq = [...new Set(ids.filter(Boolean))];
  for (const part of chunk(uniq, 100)) for (const row of await sbRows(b, `${table}?id=in.(${inList(part)})&select=${cols}`)) m.set(row.id, row);
  return m;
}

// Enrichment for a set of delivery rows: bookings, retailers, venues, store contacts. Each lookup that fails is
// named in `partial` and leaves ids unresolved; nothing here throws.
export async function enrich(b, rows) {
  const partial = [];
  let bookings = new Map(), retailers = new Map(), venues = new Map(), contacts = new Map();
  try { bookings = await byIds(b, 'bookings', rows.map(r => r.booking_id), 'id,retailer_id,venue_id,brand_id,brand_name,demo_date,demo_time,status,schedule_revision,timezone'); } catch (_) { partial.push('bookings'); }
  try { retailers = await byIds(b, 'retailers', rows.map(r => r.retailer_id).concat([...bookings.values()].map(x => x.retailer_id)), 'id,name,slug,timezone'); } catch (_) { partial.push('retailers'); }
  try { venues = await byIds(b, 'venues', [...bookings.values()].map(x => x.venue_id), 'id,name'); } catch (_) { partial.push('venues'); }
  try { contacts = await byIds(b, 'internal_contacts', rows.filter(r => r.recipient_kind === 'store_contact').map(r => r.recipient_id), 'id,name'); } catch (_) { partial.push('contacts'); }
  return { bookings, retailers, venues, contacts, partial };
}

// The public shape of one delivery row. Explicit fields; nothing else from the table leaves.
export function publicDelivery(d, ctx) {
  const bk = ctx.bookings.get(d.booking_id) || null;
  const rt = ctx.retailers.get(d.retailer_id || (bk && bk.retailer_id)) || null;
  const vn = bk ? (ctx.venues.get(bk.venue_id) || null) : null;
  const ct = d.recipient_kind === 'store_contact' ? (ctx.contacts.get(d.recipient_id) || null) : null;
  const status = d.status;
  return {
    id: d.id, event_id: d.event_id || null, booking_id: d.booking_id || null, retailer_id: d.retailer_id || (bk && bk.retailer_id) || null,
    retailer: rt ? rt.name : null, retailer_slug: rt ? rt.slug : null, timezone: (bk && bk.timezone) || (rt && rt.timezone) || null,
    venue: vn ? vn.name : null, brand: bk ? (bk.brand_name || null) : null,
    demo_date: bk ? bk.demo_date : null, demo_time: bk ? bk.demo_time : null, booking_status: bk ? bk.status : null,
    occurrence_key: d.occurrence_key || null, current_occurrence: bk && d.occurrence_key ? d.occurrence_key === `${bk.id}:${bk.schedule_revision}` : null,
    recipient_kind: d.recipient_kind, recipient_email: d.recipient_email, recipient_name: ct ? ct.name : null,
    kind: d.kind, offset_key: d.offset_key || null,
    status,
    status_label: status === 'accepted' ? 'Accepted by email provider' : status === 'pending' ? 'Scheduled' : status === 'claimed' ? 'In progress' : status === 'failed' ? (d.next_attempt_at ? 'Failed, will retry' : 'Failed') : status === 'unknown' ? 'Unknown (provider may have accepted)' : status === 'skipped' ? 'Skipped' : status,
    due_at: d.due_at, expires_at: d.expires_at || null,
    // The ONLY acceptance time we have is the recorded update when the worker wrote 'accepted'.
    accepted_at: status === 'accepted' ? d.updated_at : null,
    next_attempt_at: d.next_attempt_at || null, lease_until: status === 'claimed' ? (d.lease_until || null) : null,
    lease_expired: status === 'claimed' ? !!(d.lease_until && new Date(d.lease_until) < new Date()) : false,
    attempts: d.attempts || 0,
    skip_reason: status === 'skipped' ? (d.skip_reason || null) : null,
    error_code: status === 'failed' || status === 'unknown' ? publicErrorCode(d.last_error) : null,
    provider_accepted: !!d.provider_message_id,
    updated_at: d.updated_at,
  };
}

export async function workerHealth(b, now = new Date()) {
  const q = 'cron_heartbeat?select=ran_at,outcome,summary&cron_name=eq.notification-worker';
  const [succ, last] = await Promise.all([
    sbRows(b, `${q}&outcome=eq.succeeded&order=ran_at.desc&limit=1`),
    sbRows(b, `${q}&outcome=not.is.null&order=ran_at.desc&limit=1`),
  ]);
  const s = succ[0] || null, l = last[0] || null;
  const ageMin = s ? Math.round((now.getTime() - new Date(s.ran_at).getTime()) / 60000) : null;
  const sum = (l && l.summary && typeof l.summary === 'object') ? l.summary : null;
  return {
    last_success_at: s ? s.ran_at : null, last_success_age_minutes: ageMin,
    last_run_at: l ? l.ran_at : null, last_outcome: l ? l.outcome : null,
    // Only whitelisted numeric counters from the last run's summary; never free text.
    last_run_counts: sum ? Object.fromEntries(['claimed', 'accepted', 'skipped', 'failed', 'unknown', 'scheduled'].filter(k => Number.isFinite(sum[k])).map(k => [k, sum[k]])) : null,
    stale_after_minutes: WORKER_STALE_MINUTES,
    healthy: !!(s && ageMin !== null && ageMin <= WORKER_STALE_MINUTES && (!l || l.outcome === 'succeeded')),
  };
}

// ---- action: owner-notifications (one list page) ----
export async function listAction(b, body) {
  const p = parseListInput(body);
  if (!p.ok) return { status: 400, body: { error: p.error } };
  const w = windowFor(p.days);
  let page;
  try { page = await sbPage(b, listQuery(p.list, w, p.retailer_id), p.offset, p.limit); }
  catch (e) { console.error('owner-notifications read failed:', e?.message); return { status: 503, body: { error: 'notifications_unavailable', retry: true } }; }
  const ctx = await enrich(b, page.rows);
  return { status: 200, body: { ok: true, list: p.list, retailer_id: p.retailer_id, window: w, offset: p.offset, limit: p.limit, total: page.total, complete: page.complete, partial: ctx.partial, rows: page.rows.map(d => publicDelivery(d, ctx)) } };
}

// ---- action: owner-notifications-summary ----
export async function summaryAction(b, body) {
  const p = parseListInput({ ...(body || {}), list: 'scheduled' });
  if (!p.ok) return { status: 400, body: { error: p.error } };
  const w = windowFor(p.days);
  try {
    const [scheduled, overdue, attention, accepted, worker] = await Promise.all([
      sbCount(b, listQuery('scheduled', w, p.retailer_id)), sbCount(b, listQuery('overdue', w, p.retailer_id)),
      sbCount(b, listQuery('attention', w, p.retailer_id)), sbCount(b, listQuery('accepted', w, p.retailer_id)),
      workerHealth(b),
    ]);
    return { status: 200, body: { ok: true, retailer_id: p.retailer_id, window: w, counts: { scheduled, overdue, attention, accepted }, worker, lookahead_days: SCHEDULING_LOOKAHEAD_DAYS } };
  } catch (e) { console.error('owner-notifications-summary read failed:', e?.message); return { status: 503, body: { error: 'notifications_unavailable', retry: true } }; }
}

// ---- action: owner-booking-notifications ----
export async function bookingAction(b, body) {
  const id = body && body.booking_id;
  if (!isUuid(id)) return { status: 400, body: { error: 'booking_id must be a UUID' } };
  let bk, deliveries, events;
  try {
    const rows = await sbRows(b, `bookings?id=eq.${encodeURIComponent(id)}&select=id,retailer_id,venue_id,brand_id,brand_name,demo_date,demo_time,status,schedule_revision,timezone,created_at`);
    bk = rows[0] || null;
    if (!bk) return { status: 404, body: { error: 'booking_not_found' } };
    [deliveries, events] = await Promise.all([
      sbPage(b, `notification_deliveries?select=${DELIVERY_COLS}&booking_id=eq.${encodeURIComponent(id)}&order=due_at.asc,id.asc`, 0, MAX_LIMIT),
      sbPage(b, `notification_events?select=id,kind,transition_id,created_at,fanned_out_at&booking_id=eq.${encodeURIComponent(id)}&kind=neq.owner_booking_created&order=created_at.asc,id.asc`, 0, 100),
    ]);
  } catch (e) { console.error('owner-booking-notifications read failed:', e?.message); return { status: 503, body: { error: 'notifications_unavailable', retry: true } }; }
  const ctx = await enrich(b, deliveries.rows.length ? deliveries.rows : [{ booking_id: bk.id, retailer_id: bk.retailer_id }]);
  if (!ctx.bookings.has(bk.id)) ctx.bookings.set(bk.id, bk);
  let worker = null; try { worker = await workerHealth(b); } catch (_) { ctx.partial.push('worker'); }
  const rt = ctx.retailers.get(bk.retailer_id) || null, vn = ctx.venues.get(bk.venue_id) || null;
  const rows = deliveries.rows.map(d => publicDelivery(d, ctx));
  const currentKey = `${bk.id}:${bk.schedule_revision}`;
  // Counts: reminder TIMES are distinct offsets of the current occurrence's non-skipped reminders; recipient EMAILS
  // are rows. Both are stated so "3 reminders" can never be read two ways.
  const cur = rows.filter(r => r.occurrence_key === currentKey);
  const curRem = cur.filter(r => r.kind === 'reminder' && r.status !== 'skipped');
  const count = (xs, st) => xs.filter(r => r.status === st).length;
  const summary = {
    current_occurrence: currentKey, schedule_revision: bk.schedule_revision,
    reminder_times_scheduled: new Set(curRem.filter(r => r.status === 'pending').map(r => r.offset_key)).size,
    reminder_emails_scheduled: count(curRem, 'pending'),
    reminder_times_total: new Set(curRem.map(r => r.offset_key)).size,
    reminder_emails_total: curRem.length,
    accepted_by_provider: count(cur, 'accepted'), failed: count(cur, 'failed'), unknown: count(cur, 'unknown'), in_progress: count(cur, 'claimed'), scheduled: count(cur, 'pending'),
    skipped: count(cur, 'skipped'), skipped_reasons: Object.fromEntries([...cur.filter(r => r.status === 'skipped').reduce((m, r) => m.set(r.skip_reason || 'unspecified', (m.get(r.skip_reason || 'unspecified') || 0) + 1), new Map())]),
    earlier_occurrence_rows: rows.length - cur.length,
  };
  return { status: 200, body: { ok: true,
    booking: { id: bk.id, status: bk.status, demo_date: bk.demo_date, demo_time: bk.demo_time, timezone: bk.timezone || (rt && rt.timezone) || null, schedule_revision: bk.schedule_revision, brand: bk.brand_name || null, retailer_id: bk.retailer_id, retailer: rt ? rt.name : null, retailer_slug: rt ? rt.slug : null, venue: vn ? vn.name : null, created_at: bk.created_at },
    events: events.rows.map(e => ({ id: e.id, kind: e.kind, created_at: e.created_at, fanned_out_at: e.fanned_out_at || null })),
    events_complete: events.complete,
    deliveries: rows, deliveries_total: deliveries.total, deliveries_complete: deliveries.complete,
    summary, worker, lookahead_days: SCHEDULING_LOOKAHEAD_DAYS, partial: ctx.partial } };
}
