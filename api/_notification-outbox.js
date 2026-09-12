// api/_notification-outbox.js — the notification outbox worker's internals (Codex Release A).
//
// THE MODEL (migration 0074). Database triggers write notification_events IN THE TRANSACTION that
// changes state: a booking reaching 'confirmed' (manual confirm, auto-confirm on payment, fulfilment
// recovery, free auto-confirm at creation), a confirmed booking being cancelled/declined, an accepted
// reschedule (accept_reschedule RPC), and a COI decision (review_coi_verification). Nothing in the
// request path sends store-contact or COI-decision mail any more. This module turns those events
// into notification_deliveries (one row per recipient, or per reminder offset per recipient per
// occurrence), and then sends them — claim, recheck, freeze, send, record — so that:
//
//   * a crash anywhere leaves a durable row that the next run finishes (never a lost lifecycle mail);
//   * two workers cannot both send the same row (claim_token + lease; completion is a compare-and-set
//     on the token, so an expired worker cannot overwrite its successor);
//   * a retry can never produce a second email for the same delivery: the exact {to, subject, html}
//     is frozen BEFORE the first provider request together with the idempotency key (the delivery id),
//     and the same frozen payload is re-sent under the same key. A different payload is never sent
//     under an existing key; a changed recipient retires the row instead;
//   * a queued message that is no longer true is suppressed at dispatch: booking cancelled or moved
//     (occurrence_key = '<booking_id>:<schedule_revision>' must still match), contact deleted / out
//     of scope / opted out, reminder past its catch-up window or past the demo start, COI decision
//     superseded by a newer upload;
//   * failures are kept, not deleted: 'failed' with backoff (1m, 5m, 15m, 1h, 6h) up to 8 attempts,
//     'unknown' when a provider request may have gone out but no response came back (retried under
//     the same idempotency key only inside Resend's documented 24-hour dedupe window, then left
//     'unknown' for an operator), 'skipped' with a skip_reason for every suppressed row.
//
// CLOCK. Every function takes `now` (a Date) so tests drive DST edges, catch-up expiry and lease
// takeover deterministically. The HTTP route (api/notification-worker.js) never accepts a clock.
//
// DATABASE ACCESS is PostgREST with the service key, in bounded batches (limit/offset loops — never
// the 1000-row default page). The claim is a single filtered UPDATE (one SQL statement, so each row
// is claimed by exactly one worker); ownership is then re-read by claim_token.
//
// REMINDER SCHEDULE (api/_local-time.js reminderWindow): w1/d3/d1/d<N> at 09:00 local on the earlier
// calendar day; morning_of at 07:00 local only if the demo starts later; h1 = start - 60 min.
// expires_at = due + 2h (h1: +30 min), never later than the start. A reminder whose due_at is already
// past when it is FIRST scheduled is inserted as skipped 'due_before_scheduling' — first rollout and
// late opt-ins never produce a backlog burst, and the decision is visible in the table.

import { ownerBookedEmail, OWNER_ALERT_EMAIL } from './_owner-alerts.js';
import { randomUUID } from 'node:crypto';
import { sendMail } from './_mail.js';
import { normalizePrefs, contactInScope, lifecyclePrefKey } from './_notification-prefs.js';
import { safeZone, demoStartUtc, reminderWindow } from './_local-time.js';
import {
  FROM_ADDRESS, REPLY_TO, buildContext, confirmedMessage, reminderMessage, cancelledMessage, rescheduledMessage,
  coiApprovedMessage, coiRejectedMessage,
} from './_notification-mail.js';

export const LIFECYCLE_KINDS = ['demo_confirmed', 'demo_cancelled', 'demo_rescheduled'];
export const COI_KINDS = ['coi_approved', 'coi_rejected'];
// Codex H2 (2026-09-12): the operator's "a brand actually booked" notice. One event per booking
// (0080 trigger on the first verified payment state), one delivery to the fixed owner address; the
// hold-vs-paid wording is decided at dispatch from the CURRENT booking, then frozen like any other row.
export const OWNER_KINDS = ['owner_booking_created'];
const INACTIVE_STATUSES = ['cancelled', 'declined', 'expired', 'auth_canceled'];
// Eligible = verified money state (authorized hold or paid) AND the booking is still live. A hold that
// released/expired or a booking cancelled before the owner heard about it is obsolete unsent work.
export function ownerEligible(booking) {
  return !!booking && ['authorized', 'paid'].includes(String(booking.payment_status || '')) && !INACTIVE_STATUSES.includes(String(booking.status || ''));
}
export const BACKOFF_MINUTES = [1, 5, 15, 60, 360];
export const MAX_ATTEMPTS = 8;
export const LEASE_MS = 5 * 60 * 1000;
export const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SCHEDULE_LOOKAHEAD_MS = 31 * 24 * 60 * 60 * 1000;   // custom reminders reach 30 days
export const DEFAULTS = Object.freeze({
  fanoutBatch: 50, fanoutMaxBatches: 20,
  scheduleBatch: 100, scheduleMaxBatches: 50,
  dispatchBatch: 25, maxAttemptsPerRun: 200, sendTimeoutMs: 10000,
});
const MIN = 60000;
const enc = encodeURIComponent;

export function backoffMs(attempts) {
  const i = Math.min(Math.max(1, attempts), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i] * MIN;
}

// ---------------------------------------------------------------------------
// PostgREST helpers. Every error carries the HTTP status and PostgREST message (no row content).
// ---------------------------------------------------------------------------
export class OutboxError extends Error {
  constructor(code, detail) { super(code); this.name = 'OutboxError'; this.code = code; this.detail = detail || null; }
}
// Codex R4-03 C: every outbox database call is bounded (DB_TIMEOUT_MS) so a stalled read cannot hold a
// worker past its budget; a timeout is a db_timeout OutboxError, never a silent hang.
export const DB_TIMEOUT_MS = 15000;
async function sb(b, path, opts = {}) {
  let r;
  try {
    r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, {
      ...opts,
      signal: opts.signal || AbortSignal.timeout(DB_TIMEOUT_MS),
      headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
    });
  } catch (e) {
    throw new OutboxError((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'db_timeout' : 'db_unreachable', { path: path.split('?')[0], message: String((e && e.message) || e).slice(0, 200) });
  }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new OutboxError('db_' + (opts.method || 'GET').toLowerCase() + '_failed', { status: r.status, message: String((j && j.message) || t || '').slice(0, 200), path: path.split('?')[0] });
  return j;
}
async function countRows(b, path) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
  });
  if (!r.ok && r.status !== 416) throw new OutboxError('db_count_failed', { status: r.status, path: path.split('?')[0] });
  const cr = r.headers.get('content-range') || '';
  const m = cr.match(/\/(\d+)$/);
  return m ? Number(m[1]) : 0;
}
// Bounded pagination: keeps asking for `batch` rows until a short page or maxBatches.
async function pageAll(b, basePath, { batch, maxBatches = 50, onPage }) {
  let offset = 0, pages = 0, total = 0, truncated = false;
  for (;;) {
    const rows = await sb(b, `${basePath}&limit=${batch}&offset=${offset}`) || [];
    if (!rows.length) break;
    total += rows.length;
    await onPage(rows);
    if (rows.length < batch) break;
    offset += batch; pages++;
    if (pages >= maxBatches) { truncated = true; break; }
  }
  return { total, truncated };
}
const inList = (ids) => [...new Set(ids.filter(Boolean))].map(enc).join(',');
const idMap = (rows) => new Map((rows || []).map(r => [r.id, r]));
const errCode = (e) => (e && (e.code || e.name)) ? String(e.code || e.name) : 'error';

// ---------------------------------------------------------------------------
// Shared loaders with a per-run cache (a run touches the same booking/retailer/brand many times).
// ---------------------------------------------------------------------------
export function makeCache() { return { bookings: new Map(), retailers: new Map(), venues: new Map(), brands: new Map(), internal_contacts: new Map(), notification_events: new Map(), contactsByRetailer: new Map() }; }
async function loadOne(b, cache, table, id, select = '*') {
  if (!id) return null;
  const m = cache[table];
  if (m.has(id)) return m.get(id);
  const rows = await sb(b, `${table}?id=eq.${enc(id)}&select=${select}`);
  const row = Array.isArray(rows) ? rows[0] || null : null;
  m.set(id, row);
  return row;
}
// Fresh (uncached) read — used by the dispatch recheck, which must see the CURRENT state.
async function loadFresh(b, table, id, select = '*') {
  if (!id) return null;
  const rows = await sb(b, `${table}?id=eq.${enc(id)}&select=${select}`);
  return Array.isArray(rows) ? rows[0] || null : null;
}
const CONTACT_SELECT = 'id,retailer_id,name,email,venue_ids,notification_prefs';
async function loadContactsForRetailer(b, cache, retailerId) {
  if (cache.contactsByRetailer.has(retailerId)) return cache.contactsByRetailer.get(retailerId);
  const out = [];
  await pageAll(b, `internal_contacts?retailer_id=eq.${enc(retailerId)}&select=${CONTACT_SELECT}&order=id.asc`, {
    batch: 200, maxBatches: 50, onPage: (rows) => { out.push(...rows); },
  });
  const list = out.filter(c => c && c.email && String(c.email).trim()).map(c => ({ ...c, email: String(c.email).trim(), prefs: normalizePrefs(c.notification_prefs) }));
  cache.contactsByRetailer.set(retailerId, list);
  return list;
}
export function bookingStartAt(booking, tz) {
  if (!booking) return null;
  if (booking.start_at) { const d = new Date(booking.start_at); if (!Number.isNaN(d.getTime())) return d; }
  return demoStartUtc(booking.demo_date, booking.demo_time, tz);   // strict: null if unresolvable
}
export const occurrenceKeyOf = (booking) => `${booking.id}:${booking.schedule_revision == null ? 1 : booking.schedule_revision}`;

// ---------------------------------------------------------------------------
// 1. FAN-OUT: notification_events (fanned_out_at IS NULL) -> notification_deliveries.
// ---------------------------------------------------------------------------
async function insertDeliveries(b, rows) {
  if (!rows.length) return 0;
  const inserted = await sb(b, 'notification_deliveries?on_conflict=dedupe_key', {
    method: 'POST', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' }, body: JSON.stringify(rows),
  });
  return Array.isArray(inserted) ? inserted.length : 0;
}
async function markFannedOut(b, ev, now, note) {
  const patch = { fanned_out_at: now.toISOString() };
  if (note) patch.payload = { ...(ev.payload || {}), fanout_note: note };
  await sb(b, `notification_events?id=eq.${enc(ev.id)}&fanned_out_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
}

// Server-resolved brand recipients: the brand's account email plus its team members. Never client input.
async function brandRecipients(b, brand) {
  const out = [];
  const seen = new Set();
  const add = (id, email) => {
    const e = String(email || '').trim();
    if (!e || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase()); out.push({ recipient_id: id, email: e });
  };
  add(brand.id, brand.email);
  try {
    const members = await sb(b, `brand_members?brand_id=eq.${enc(brand.id)}&select=id,email&order=created_at.asc&limit=50`) || [];
    for (const m of members) add(m.id, m.email);
  } catch (_) { /* members are additive; the primary account email is the required recipient */ }
  return out;
}

async function fanOutOne(b, cache, ev, now) {
  const payload = ev.payload || {};
  if (LIFECYCLE_KINDS.includes(ev.kind)) {
    const booking = await loadFresh(b, 'bookings', ev.booking_id);
    if (!booking) { await markFannedOut(b, ev, now, 'booking_missing'); return { deliveries: 0, skipped: true }; }
    // A confirmation or a move for a booking that is no longer confirmed is stale: the cancellation
    // event (already emitted by the trigger) is what the contacts should hear.
    if ((ev.kind === 'demo_confirmed' || ev.kind === 'demo_rescheduled') && booking.status !== 'confirmed') {
      await markFannedOut(b, ev, now, `skipped_booking_${booking.status}`); return { deliveries: 0, skipped: true };
    }
    // A move superseded by a later move before fan-out would announce the wrong "now".
    const evRev = payload.schedule_revision != null ? Number(payload.schedule_revision) : null;
    if (ev.kind !== 'demo_cancelled' && evRev != null && Number(booking.schedule_revision == null ? 1 : booking.schedule_revision) !== evRev) {
      await markFannedOut(b, ev, now, `superseded_by_revision_${booking.schedule_revision}`); return { deliveries: 0, skipped: true };
    }
    const prefKey = lifecyclePrefKey(ev.kind);
    const contacts = await loadContactsForRetailer(b, cache, booking.retailer_id);
    const targets = contacts.filter(c => c.retailer_id === booking.retailer_id && contactInScope(c, booking.venue_id) && c.prefs[prefKey] === true);
    const occurrence = `${booking.id}:${evRev != null ? evRev : (booking.schedule_revision == null ? 1 : booking.schedule_revision)}`;
    const rows = targets.map(c => ({
      event_id: ev.id, retailer_id: booking.retailer_id, booking_id: booking.id,
      recipient_kind: 'store_contact', recipient_id: c.id, recipient_email: c.email,
      kind: ev.kind, offset_key: null, occurrence_key: occurrence,
      dedupe_key: `${ev.kind}:${ev.transition_id}:store_contact:${c.id}`,
      due_at: now.toISOString(), expires_at: null, status: 'pending', attempts: 0,
    }));
    const n = await insertDeliveries(b, rows);
    await markFannedOut(b, ev, now, targets.length ? null : 'no_recipients');
    return { deliveries: n, skipped: false };
  }
  if (COI_KINDS.includes(ev.kind)) {
    const brand = await loadFresh(b, 'brands', ev.brand_id, 'id,email,company_name,current_coi_verification_id');
    if (!brand) { await markFannedOut(b, ev, now, 'brand_missing'); return { deliveries: 0, skipped: true }; }
    const recipients = await brandRecipients(b, brand);
    const rows = recipients.map(r => ({
      event_id: ev.id, retailer_id: null, booking_id: null,
      recipient_kind: 'brand', recipient_id: r.recipient_id, recipient_email: r.email,
      kind: ev.kind, offset_key: null, occurrence_key: null,
      dedupe_key: `${ev.kind}:${ev.transition_id}:brand:${r.recipient_id}`,
      due_at: now.toISOString(), expires_at: null, status: 'pending', attempts: 0,
    }));
    const n = await insertDeliveries(b, rows);
    await markFannedOut(b, ev, now, recipients.length ? null : 'no_recipients');
    return { deliveries: n, skipped: false };
  }
  if (OWNER_KINDS.includes(ev.kind)) {
    const booking = await loadFresh(b, 'bookings', ev.booking_id);
    if (!booking) { await markFannedOut(b, ev, now, 'booking_missing'); return { deliveries: 0, skipped: true }; }
    if (!ownerEligible(booking)) { await markFannedOut(b, ev, now, `skipped_booking_${INACTIVE_STATUSES.includes(String(booking.status || '')) ? booking.status : 'no_longer_' + (booking.payment_status || 'paid')}`); return { deliveries: 0, skipped: true }; }
    const rows = [{
      event_id: ev.id, retailer_id: booking.retailer_id, booking_id: booking.id,
      recipient_kind: 'owner', recipient_id: null, recipient_email: OWNER_ALERT_EMAIL,
      kind: ev.kind, offset_key: null, occurrence_key: null,
      dedupe_key: `${ev.kind}:${ev.transition_id}:owner`,
      due_at: now.toISOString(), expires_at: null, status: 'pending', attempts: 0,
    }];
    const n = await insertDeliveries(b, rows);
    await markFannedOut(b, ev, now, null);
    return { deliveries: n, skipped: false };
  }
  await markFannedOut(b, ev, now, 'unknown_kind');
  return { deliveries: 0, skipped: true };
}

export async function fanOutEvents(b, { now = new Date(), batch = DEFAULTS.fanoutBatch, maxBatches = DEFAULTS.fanoutMaxBatches, cache = makeCache() } = {}) {
  const out = { events: 0, deliveries: 0, skipped_events: 0, errors: [] };
  const seen = new Set();
  for (let i = 0; i < maxBatches; i++) {
    const events = await sb(b, `notification_events?fanned_out_at=is.null&select=*&order=created_at.asc,id.asc&limit=${batch}`) || [];
    const fresh = events.filter(e => !seen.has(e.id));
    if (!fresh.length) break;
    for (const ev of fresh) {
      seen.add(ev.id);
      out.events++;
      try {
        const r = await fanOutOne(b, cache, ev, now);
        out.deliveries += r.deliveries;
        if (r.skipped) out.skipped_events++;
      } catch (e) { out.errors.push(`fanout:${ev.kind}:${errCode(e)}`); }
    }
    if (events.length < batch) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. REMINDER SCHEDULING: confirmed future bookings x in-scope contacts x selected offsets.
// ---------------------------------------------------------------------------
export async function scheduleReminders(b, { now = new Date(), batch = DEFAULTS.scheduleBatch, maxBatches = DEFAULTS.scheduleMaxBatches, cache = makeCache() } = {}) {
  const out = { bookings: 0, contacts: 0, rows_pending: 0, rows_skipped: 0, unresolvable: 0, truncated: false, errors: [] };
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_MS).toISOString();
  const base = `bookings?status=eq.confirmed&start_at=gt.${enc(nowIso)}&start_at=lt.${enc(horizon)}&select=id,retailer_id,venue_id,status,demo_date,demo_time,start_at,end_at,timezone,schedule_revision&order=start_at.asc,id.asc`;
  const page = await pageAll(b, base, {
    batch, maxBatches,
    onPage: async (bookings) => {
      const retailerIds = [...new Set(bookings.map(x => x.retailer_id).filter(Boolean))];
      const missing = retailerIds.filter(id => !cache.retailers.has(id));
      if (missing.length) {
        const rs = await sb(b, `retailers?id=in.(${inList(missing)})&select=id,name,slug,timezone`) || [];
        for (const r of rs) cache.retailers.set(r.id, r);
        for (const id of missing) if (!cache.retailers.has(id)) cache.retailers.set(id, null);
      }
      for (const booking of bookings) {
        out.bookings++;
        try {
          const retailer = cache.retailers.get(booking.retailer_id);
          const tz = safeZone(booking.timezone || (retailer && retailer.timezone));
          const startAt = bookingStartAt(booking, tz);
          if (!startAt || startAt.getTime() <= now.getTime()) { out.unresolvable++; continue; }
          const occurrence = occurrenceKeyOf(booking);
          const contacts = (await loadContactsForRetailer(b, cache, booking.retailer_id)).filter(c => contactInScope(c, booking.venue_id) && c.prefs.reminders.length);
          const rows = [];
          for (const c of contacts) {
            out.contacts++;
            for (const offset of c.prefs.reminders) {
              const win = reminderWindow(offset, startAt, tz);
              // Every row carries the SAME keys: PostgREST refuses a bulk insert of mixed shapes.
              const row = {
                event_id: null, retailer_id: booking.retailer_id, booking_id: booking.id,
                recipient_kind: 'store_contact', recipient_id: c.id, recipient_email: c.email,
                kind: 'reminder', offset_key: offset, occurrence_key: occurrence,
                dedupe_key: `reminder:${occurrence}:store_contact:${c.id}:${offset}`,
                attempts: 0, due_at: null, expires_at: null, status: 'pending', skip_reason: null,
              };
              if (!win.ok) {
                Object.assign(row, { due_at: startAt.toISOString(), expires_at: startAt.toISOString(), status: 'skipped', skip_reason: win.skip });
              } else if (win.due_at.getTime() <= now.getTime()) {
                // First rollout / late opt-in: never a backlog burst, always an explainable row.
                Object.assign(row, { due_at: win.due_at.toISOString(), expires_at: win.expires_at.toISOString(), status: 'skipped', skip_reason: 'due_before_scheduling' });
              } else {
                Object.assign(row, { due_at: win.due_at.toISOString(), expires_at: win.expires_at.toISOString() });
              }
              rows.push(row);
            }
          }
          if (!rows.length) continue;
          const inserted = await sb(b, 'notification_deliveries?on_conflict=dedupe_key', {
            method: 'POST', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' }, body: JSON.stringify(rows),
          });
          for (const r of (Array.isArray(inserted) ? inserted : [])) { if (r.status === 'skipped') out.rows_skipped++; else out.rows_pending++; }
        } catch (e) { out.errors.push(`schedule:${errCode(e)}`); }
      }
    },
  });
  out.truncated = page.truncated;
  return out;
}

// ---------------------------------------------------------------------------
// 3. DISPATCH: claim due rows, recheck, freeze, send, record.
// ---------------------------------------------------------------------------
// A row is claimable when it is due and either pending (never claimed), failed/unknown with its
// retry time reached, or claimed with an EXPIRED lease (the previous worker died mid-flight; we take
// it over with a NEW token, so its late completion can no longer match).
export function claimFilter(nowIso) {
  return `due_at=lte.${enc(nowIso)}&or=(and(status.eq.pending,claim_token.is.null),and(status.eq.failed,next_attempt_at.lte.${nowIso}),and(status.eq.unknown,next_attempt_at.lte.${nowIso}),and(status.eq.claimed,lease_until.lt.${nowIso}))`;
}
// CLAIM PROTOCOL (PostgREST cannot do UPDATE ... LIMIT — verified against the test project: a
// `limit` on PATCH is ignored — so the batch bound is a SELECT and atomicity is the filtered UPDATE):
//   1. SELECT up to `batch` claimable ids (oldest due first).
//   2. UPDATE those ids WITH THE SAME CLAIMABILITY FILTER, setting status/claim_token/lease. One SQL
//      statement: under READ COMMITTED a concurrent worker that picked the same ids blocks on the row
//      lock and re-evaluates the WHERE on the committed version — which is now claimed by us — so it
//      updates zero of them. Exactly one winner per row.
//   3. SELECT rows carrying OUR token. Ownership is what the database says, never what we asked for.
export async function claimDue(b, { now, batch, claimToken }) {
  const nowIso = now.toISOString();
  const filter = claimFilter(nowIso);
  const candidates = await sb(b, `notification_deliveries?${filter}&select=id&order=due_at.asc,id.asc&limit=${batch}`) || [];
  if (!candidates.length) return [];
  const ids = candidates.map(r => enc(r.id)).join(',');
  await sb(b, `notification_deliveries?id=in.(${ids})&${filter}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'claimed', claim_token: claimToken, lease_until: new Date(now.getTime() + LEASE_MS).toISOString(), updated_at: nowIso }),
  });
  return await sb(b, `notification_deliveries?claim_token=eq.${enc(claimToken)}&status=eq.claimed&select=*&order=due_at.asc,id.asc`) || [];
}

// Compare-and-set completion: only the worker still holding the token may write. 0 rows = lost lease.
async function cas(b, row, token, patch) {
  const rows = await sb(b, `notification_deliveries?id=eq.${enc(row.id)}&claim_token=eq.${enc(token)}&status=eq.claimed`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new OutboxError('completion_mismatch', { id: row.id });
  return rows[0];
}
const release = (extra) => ({ claim_token: null, lease_until: null, ...extra });

// The recheck: is this delivery still true, and to whom? Returns { ok, message } or { skip }.
async function recheckAndBuild(b, cache, row, now) {
  const event = row.event_id ? await loadOne(b, cache, 'notification_events', row.event_id).catch(() => null) : null;
  const payload = (event && event.payload) || {};
  if (row.recipient_kind === 'store_contact') {
    const booking = await loadFresh(b, 'bookings', row.booking_id);
    if (!booking) return { skip: 'booking_missing' };
    if (row.retailer_id && booking.retailer_id !== row.retailer_id) return { skip: 'tenant_mismatch' };
    const retailer = await loadOne(b, cache, 'retailers', booking.retailer_id, 'id,name,slug,timezone');
    const tz = safeZone(booking.timezone || (retailer && retailer.timezone));
    const startAt = bookingStartAt(booking, tz);
    const occurrence = occurrenceKeyOf(booking);
    if (row.kind === 'reminder' || row.kind === 'demo_confirmed' || row.kind === 'demo_rescheduled') {
      if (booking.status !== 'confirmed') return { skip: `booking_${booking.status || 'not_confirmed'}` };
      if (row.occurrence_key && row.occurrence_key !== occurrence) return { skip: 'rescheduled' };
      if (!startAt) return { skip: 'unresolvable_schedule' };
      if (startAt.getTime() <= now.getTime()) return { skip: 'demo_started' };
    }
    if (row.kind === 'reminder' && row.expires_at && new Date(row.expires_at).getTime() < now.getTime()) return { skip: 'expired' };
    if (row.kind === 'demo_cancelled' && booking.status === 'confirmed') return { skip: 'booking_reconfirmed' };

    const contact = await loadFresh(b, 'internal_contacts', row.recipient_id, CONTACT_SELECT);
    if (!contact) return { skip: 'recipient_deleted' };
    if (contact.retailer_id !== booking.retailer_id) return { skip: 'tenant_mismatch' };
    if (!contactInScope(contact, booking.venue_id)) return { skip: 'out_of_scope' };
    const prefs = normalizePrefs(contact.notification_prefs);
    if (row.kind === 'reminder') { if (!prefs.reminders.includes(row.offset_key)) return { skip: 'opted_out' }; }
    else if (prefs[lifecyclePrefKey(row.kind)] !== true) return { skip: 'opted_out' };
    const to = String(contact.email || '').trim();
    if (!to) return { skip: 'recipient_no_email' };

    const venue = booking.venue_id ? await loadOne(b, cache, 'venues', booking.venue_id, 'id,name,address') : null;
    const brand = booking.brand_id ? await loadOne(b, cache, 'brands', booking.brand_id, 'id,company_name,contact_name,phone').catch(() => null) : null;
    const ctx = buildContext({ booking, retailer, venue, brand });
    let message;
    if (row.kind === 'demo_confirmed') message = confirmedMessage(b, ctx);
    else if (row.kind === 'reminder') message = reminderMessage(b, ctx, now);
    else if (row.kind === 'demo_cancelled') message = cancelledMessage(b, ctx, { reason: payload.cancel_reason || booking.cancel_reason || null });
    else if (row.kind === 'demo_rescheduled') {
      let from = null;
      if (payload.old_date) {
        const fromStart = demoStartUtc(payload.old_date, payload.old_time, tz, { lenientTime: true });
        if (fromStart) from = { startAt: fromStart, endAt: new Date(fromStart.getTime() + Math.max(0, (ctx.endAt || fromStart).getTime() - (ctx.startAt || fromStart).getTime())) };
      }
      message = rescheduledMessage(b, ctx, { from });
    } else return { skip: 'unknown_kind' };
    return { ok: true, to, message };
  }

  if (row.recipient_kind === 'brand') {
    if (!event) return { skip: 'event_missing' };
    const verificationId = payload.verification_id || String(event.transition_id || '').split(':')[0];
    const verification = await loadFresh(b, 'coi_verifications', verificationId, 'id,brand_id,status,review_decision,policy_expiry,brand_note,superseded_at,removed_at');
    if (!verification) return { skip: 'verification_missing' };
    if (verification.superseded_at || verification.removed_at) return { skip: 'superseded' };
    const st = String(verification.status || '').toLowerCase();
    const approvedNow = st === 'approved' || st === 'passed' || verification.review_decision === 'approved';
    if (row.kind === 'coi_approved' && !approvedNow) return { skip: 'decision_changed' };
    if (row.kind === 'coi_rejected' && !(st === 'rejected' || verification.review_decision === 'rejected')) return { skip: 'decision_changed' };
    const brand = await loadFresh(b, 'brands', verification.brand_id, 'id,email,company_name,current_coi_verification_id');
    if (!brand) return { skip: 'brand_missing' };
    if (event.brand_id && event.brand_id !== brand.id) return { skip: 'tenant_mismatch' };
    if (brand.current_coi_verification_id && brand.current_coi_verification_id !== verification.id) return { skip: 'superseded' };
    let to = null;
    if (row.recipient_id === brand.id) to = brand.email;
    else {
      const member = await loadFresh(b, 'brand_members', row.recipient_id, 'id,brand_id,email');
      if (!member) return { skip: 'recipient_deleted' };
      if (member.brand_id !== brand.id) return { skip: 'tenant_mismatch' };
      to = member.email;
    }
    to = String(to || '').trim();
    if (!to) return { skip: 'recipient_no_email' };
    const v = { ...verification, expires_at: payload.expires_at || verification.policy_expiry || null, brand_note: verification.brand_note != null ? verification.brand_note : (payload.brand_note || null) };
    const message = row.kind === 'coi_approved' ? coiApprovedMessage(b, { brand, verification: v }) : coiRejectedMessage(b, { brand, verification: v });
    return { ok: true, to, message };
  }
  if (row.recipient_kind === 'owner') {
    // Codex H2: judged on the CURRENT booking at dispatch. A hold captured before this send goes out
    // as the paid version; a hold that released, or a booking cancelled/declined before the owner
    // heard, is skipped with an explicit reason. The retailer's confirmation mode is read fresh so the
    // hold instructions match what the retailer actually has to do.
    const booking = await loadFresh(b, 'bookings', row.booking_id);
    if (!booking) return { skip: 'booking_missing' };
    if (row.retailer_id && booking.retailer_id !== row.retailer_id) return { skip: 'tenant_mismatch' };
    if (!ownerEligible(booking)) return { skip: INACTIVE_STATUSES.includes(String(booking.status || '')) ? `booking_${booking.status}` : `booking_no_longer_${booking.payment_status || 'paid'}` };
    const retailer = await loadFresh(b, 'retailers', booking.retailer_id, 'id,name,slug,timezone,auto_confirm_bookings');
    const venue = booking.venue_id ? await loadOne(b, cache, 'venues', booking.venue_id, 'id,name,address') : null;
    let settingDuration = null;
    try { const s = await sb(b, `settings?retailer_id=eq.${enc(booking.retailer_id)}&select=demo_duration&limit=1`); settingDuration = Array.isArray(s) && s[0] ? s[0].demo_duration : null; } catch (_) {}
    const facts = {
      autoConfirm: retailer && typeof retailer.auto_confirm_bookings === 'boolean' ? retailer.auto_confirm_bookings : null,
      retailerTimezone: (retailer && retailer.timezone) || null,
      settingDuration,
    };
    const kind = booking.payment_status === 'paid' ? 'paid' : 'hold';
    const ctx = { ...booking, booking_id: booking.id, venues: venue ? { name: venue.name } : null, retailers: retailer ? { name: retailer.name, slug: retailer.slug } : null };
    const built = ownerBookedEmail(ctx, { kind, targetStatus: booking.status === 'confirmed' ? 'confirmed' : 'pending', facts }, b);
    return { ok: true, to: OWNER_ALERT_EMAIL, message: { subject: built.subject, html: built.html } };
  }
  return { skip: 'unknown_recipient_kind' };
}

// Send one claimed row. Returns 'accepted' | 'skipped' | 'failed' | 'unknown' | 'lost'.
// Codex R4-03 B: delivery uncertainty lives in the frozen envelope (outside the immutable provider
// fields to/subject/html), NOT in the lease/work status that claimDue rewrites. A row is uncertain when
//   * a previous attempt got no usable answer (uncertain:true — provider unreachable, aborted, or an
//     unverifiable acknowledgment), or
//   * a previous attempt was marked as starting (attempting_at) and never settled (crash mid-send), or
//   * the envelope predates this contract (legacy: no 'uncertain' field) — handled conservatively.
// Only a verified acceptance clears it; a later definite rejection cannot.
export function uncertaintyOf(frozen) {
  if (!frozen || typeof frozen !== 'object') return { uncertain: false, reason: null };
  if (frozen.uncertain === true) return { uncertain: true, reason: 'prior_attempt_uncertain' };
  const started = Date.parse(String(frozen.attempting_at || ''));
  const settled = Date.parse(String(frozen.settled_at || ''));
  if (Number.isFinite(started) && (!Number.isFinite(settled) || settled < started)) return { uncertain: true, reason: 'prior_attempt_unsettled' };
  if (frozen.uncertain === false) return { uncertain: false, reason: null };
  return { uncertain: true, reason: 'legacy_envelope' };
}

export async function processClaimed(b, row, { now = new Date(), clock = null, token, mailer = sendMail, sendTimeoutMs = DEFAULTS.sendTimeoutMs, cache = makeCache() } = {}) {
  const nowIso = now.toISOString();
  try {
    const check = await recheckAndBuild(b, cache, row, now);
    if (!check.ok) {
      await cas(b, row, token, release({ status: 'skipped', skip_reason: check.skip, updated_at: nowIso }));
      return { outcome: 'skipped', reason: check.skip };
    }
    // Codex R4-03 A: the per-ATTEMPT clock. A worker's run clock (now) is fixed when the run starts;
    // eligibility is judged when THIS attempt is about to send.
    const attemptAt = typeof clock === 'function' ? clock() : now;
    const attemptIso = attemptAt.toISOString();
    // FREEZE. The first attempt fixes {to, subject, html} and the provider key (the delivery id).
    // Later attempts re-send exactly that; a payload built now is only used when nothing was frozen.
    const priorAttempt = !!(row.frozen_payload && typeof row.frozen_payload === 'object');
    let frozen = priorAttempt ? row.frozen_payload : null;
    if (frozen) {
      if (String(frozen.to || '').toLowerCase() !== check.to.toLowerCase()) {
        await cas(b, row, token, release({ status: 'skipped', skip_reason: 'recipient_changed', updated_at: attemptIso }));
        return { outcome: 'skipped', reason: 'recipient_changed' };
      }
    }
    const history = uncertaintyOf(frozen);
    const attemptsSoFar = row.attempts || 0;
    if (priorAttempt) {
      // Codex R4-03 A: the eligibility decision comes BEFORE any provider call. Resend deduplicates a
      // key for 24h only; a re-send outside that window (or with no trustworthy first-attempt time to
      // measure it from) could be a duplicate. Such work is terminal — surfaced for an operator — with
      // ZERO provider calls, and it keeps its uncertainty ('unknown' when a send may have gone out).
      const firstAttemptMs = Date.parse(String(frozen.attempted_at || ''));
      const terminal = !Number.isFinite(firstAttemptMs) ? 'review_required'
        : (attemptAt.getTime() - firstAttemptMs >= RESEND_IDEMPOTENCY_WINDOW_MS) ? 'idempotency_window_expired' : null;
      if (terminal) {
        const status = history.uncertain ? 'unknown' : 'failed';
        await cas(b, row, token, release({ status, attempts: attemptsSoFar, next_attempt_at: null, skip_reason: terminal,
          last_error: String(terminal + (history.reason ? ': ' + history.reason : '')).slice(0, 300), updated_at: attemptIso,
          frozen_payload: { ...frozen, uncertain: history.uncertain, settled_at: attemptIso } }));
        return { outcome: status, final: true, reason: terminal, calls: 0 };
      }
      // Codex R4-03 B: mark THIS attempt durably before the send. A crash between here and the settle
      // leaves attempting_at newer than settled_at — which the next claim reads as uncertain.
      frozen = { ...frozen, uncertain: history.uncertain, attempting_at: attemptIso };
      await cas(b, row, token, { frozen_payload: frozen, updated_at: attemptIso });
    } else {
      frozen = { to: check.to, subject: check.message.subject, html: check.message.html, attempted_at: attemptIso, attempting_at: attemptIso, uncertain: false };
      await cas(b, row, token, { frozen_payload: frozen, idempotency_key: row.id, recipient_email: check.to, updated_at: attemptIso });
    }
    const attempts = attemptsSoFar + 1;
    const key = row.idempotency_key || row.id;
    let sent = null, err = null;
    try {
      sent = await mailer({ from: FROM_ADDRESS, to: frozen.to, replyTo: REPLY_TO, subject: frozen.subject, html: frozen.html }, { binding: b, idempotencyKey: key, timeoutMs: sendTimeoutMs });
    } catch (e) { err = e; }
    if (sent && sent.ok) {
      // A verified acceptance resolves any earlier uncertainty.
      await cas(b, row, token, release({ status: 'accepted', provider_message_id: sent.id || null, attempts, next_attempt_at: null, last_error: null, updated_at: attemptIso,
        frozen_payload: { ...frozen, uncertain: false, settled_at: attemptIso, resolved_at: attemptIso } }));
      return { outcome: 'accepted' };
    }
    const code = errCode(err) || (sent && sent.code) || 'send_failed';
    const lastError = String(code + (err && err.detail && typeof err.detail === 'string' ? ': ' + err.detail : '')).slice(0, 300);
    // The request may have reached the provider (no answer / aborted / unverifiable acknowledgment).
    const maybeSent = code === 'mail_provider_unreachable' || code === 'mail_ack_unverified';
    // Uncertainty is sticky: a definite rejection NOW does not erase a possible acceptance BEFORE.
    const uncertain = history.uncertain || maybeSent;
    const envelope = { ...frozen, uncertain, settled_at: attemptIso };
    const status = uncertain ? 'unknown' : 'failed';
    if (attempts >= MAX_ATTEMPTS) {
      await cas(b, row, token, release({ status, attempts, next_attempt_at: null, skip_reason: 'max_attempts', last_error: lastError, updated_at: attemptIso, frozen_payload: envelope }));
      return { outcome: status, final: true };
    }
    await cas(b, row, token, release({ status, attempts, next_attempt_at: new Date(attemptAt.getTime() + backoffMs(attempts)).toISOString(), last_error: lastError, updated_at: attemptIso, frozen_payload: envelope }));
    return { outcome: status };
  } catch (e) {
    if (e && e.code === 'completion_mismatch') {
      const current = await loadFresh(b, 'notification_deliveries', row.id, 'id,status,skip_reason').catch(() => null);
      if (current && current.status === 'skipped') return { outcome: 'skipped', reason: current.skip_reason || 'retired' };
      return { outcome: 'lost' };
    }
    // A database error while recording: leave the row claimed (the lease expires and the next run
    // takes it over) and report the run as failed.
    return { outcome: 'error', code: errCode(e) };
  }
}

export async function dispatchDue(b, { now = new Date(), clock = null, batch = DEFAULTS.dispatchBatch, maxAttempts = DEFAULTS.maxAttemptsPerRun, sendTimeoutMs = DEFAULTS.sendTimeoutMs, mailer = sendMail, cache = makeCache() } = {}) {
  const out = { claimed: 0, accepted: 0, skipped: 0, failed: 0, unknown: 0, lost: 0, attempts: 0, budget_exhausted: false, errors: [], skip_reasons: {} };
  while (out.attempts < maxAttempts) {
    const n = Math.min(batch, maxAttempts - out.attempts);
    const token = randomUUID();
    let rows;
    try { rows = await claimDue(b, { now, batch: n, claimToken: token }); }
    catch (e) { out.errors.push(`claim:${errCode(e)}`); break; }
    if (!rows.length) break;
    for (const row of rows) {
      out.claimed++; out.attempts++;
      const r = await processClaimed(b, row, { now, clock, token, mailer, sendTimeoutMs, cache });
      if (r.outcome === 'accepted') out.accepted++;
      else if (r.outcome === 'skipped') { out.skipped++; out.skip_reasons[r.reason] = (out.skip_reasons[r.reason] || 0) + 1; }
      else if (r.outcome === 'failed') { out.failed++; out.errors.push('send_failed'); }
      else if (r.outcome === 'unknown') { out.unknown++; out.errors.push('send_unknown'); }
      else if (r.outcome === 'lost') { out.lost++; out.errors.push('completion_mismatch'); }
      else { out.errors.push(`dispatch:${r.code || 'error'}`); }
    }
    if (rows.length < n) break;
  }
  if (out.attempts >= maxAttempts) out.budget_exhausted = true;
  return out;
}

// ---------------------------------------------------------------------------
// 4. METRICS — backlog and oldest pending age are reported separately from liveness.
// ---------------------------------------------------------------------------
export async function collectMetrics(b, { now = new Date() } = {}) {
  const nowIso = enc(now.toISOString());
  const overdue = enc(new Date(now.getTime() - 60 * MIN).toISOString());
  const [backlog, overdueCount, failed, unknown, oldest] = await Promise.all([
    countRows(b, `notification_deliveries?status=eq.pending&due_at=lte.${nowIso}&select=id`),
    countRows(b, `notification_deliveries?status=eq.pending&due_at=lte.${overdue}&select=id`),
    countRows(b, `notification_deliveries?status=eq.failed&select=id`),
    countRows(b, `notification_deliveries?status=eq.unknown&select=id`),
    sb(b, `notification_deliveries?status=eq.pending&due_at=lte.${nowIso}&select=due_at&order=due_at.asc&limit=1`),
  ]);
  const oldestDue = Array.isArray(oldest) && oldest[0] ? new Date(oldest[0].due_at) : null;
  return {
    backlog_pending: backlog,
    backlog_overdue_60m: overdueCount,
    oldest_pending_age_min: oldestDue ? Math.max(0, Math.round((now.getTime() - oldestDue.getTime()) / MIN)) : 0,
    failed_count: failed,
    unknown_count: unknown,
  };
}

// ---------------------------------------------------------------------------
// One worker run. ok = every step ran without error and every attempted send was accepted or
// skipped by design. A failed/unknown send, a lost lease, a failed enqueue or read, or a failed
// completion record all make the run NOT ok — the route writes a 'failed' heartbeat and answers 500.
// ---------------------------------------------------------------------------
export async function runWorker(b, { now = new Date(), mailer = sendMail, budgets = {} } = {}) {
  // Codex R4-03 A: the run clock is fixed at start (for the audit line); each dispatch attempt reads a
  // clock that advances with real elapsed time from it — a long run cannot re-send under a decision
  // made minutes ago.
  const startedRealMs = Date.now();
  const clock = () => new Date(now.getTime() + (Date.now() - startedRealMs));
  const cache = makeCache();
  const summary = { ok: true, now: now.toISOString(), errors: 0, first_error: null };
  const errors = [];
  const step = async (name, fn) => {
    try { summary[name] = await fn(); errors.push(...(summary[name].errors || []).map(e => `${name}:${e}`)); }
    catch (e) { summary[name] = { error: errCode(e) }; errors.push(`${name}:${errCode(e)}`); }
  };
  await step('fanout', () => fanOutEvents(b, { now, cache, batch: budgets.fanoutBatch }));
  await step('schedule', () => scheduleReminders(b, { now, cache, batch: budgets.scheduleBatch }));
  await step('dispatch', () => dispatchDue(b, { now, clock, cache, mailer, batch: budgets.dispatchBatch, maxAttempts: budgets.maxAttemptsPerRun, sendTimeoutMs: budgets.sendTimeoutMs }));
  await step('metrics', () => collectMetrics(b, { now }));
  for (const k of ['fanout', 'schedule', 'dispatch']) if (summary[k] && Array.isArray(summary[k].errors)) summary[k].errors = summary[k].errors.length;
  summary.errors = errors.length;
  summary.first_error = errors.length ? String(errors[0]).slice(0, 200) : null;
  summary.ok = errors.length === 0;
  return summary;
}
