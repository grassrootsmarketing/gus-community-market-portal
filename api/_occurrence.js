// api/_occurrence.js — Codex R3 (2026-09-11): the ACCEPTED occurrence of a demo is its booking's
// snapshot (bookings.start_at / end_at / timezone, 0074–0077). A calendar feed must read that
// snapshot with a SUCCESSFUL lookup or fail closed — it must never reconstruct a linked appointment
// from the retailer's current settings because a lookup happened to fail (that shifts accepted
// appointments and the result can be cached).
//
//   fetchBookingSnapshots(get, ids) -> Map<booking_id, {start_at, end_at, timezone}>   (throws on any failure)
//   `get(path)` performs a service-role GET against PostgREST and returns { ok, status, json() }.
//   Ids are de-duplicated and looked up in chunks so a large feed never builds an oversized URL; a
//   failed or malformed chunk throws, and the caller answers 503 with Cache-Control: no-store.
export const SNAPSHOT_CHUNK = 100;

export class SnapshotLookupError extends Error {
  constructor(message, detail) { super(message); this.name = 'SnapshotLookupError'; this.detail = detail; }
}

export async function fetchBookingSnapshots(get, ids, { chunk = SNAPSHOT_CHUNK } = {}) {
  const out = new Map();
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  for (let i = 0; i < uniqueIds.length; i += chunk) {
    const part = uniqueIds.slice(i, i + chunk);
    let rows;
    try {
      const r = await get(`bookings?id=in.(${part.map(encodeURIComponent).join(',')})&select=id,start_at,end_at,timezone`);
      if (!r || !r.ok) throw new SnapshotLookupError('snapshot_lookup_failed', { status: r && r.status });
      rows = await r.json();
    } catch (e) {
      if (e instanceof SnapshotLookupError) throw e;
      throw new SnapshotLookupError('snapshot_lookup_failed', { error: String((e && e.message) || e).slice(0, 200) });
    }
    if (!Array.isArray(rows)) throw new SnapshotLookupError('snapshot_lookup_malformed', { got: typeof rows });
    for (const b of rows) {
      if (!b || typeof b.id !== 'string') throw new SnapshotLookupError('snapshot_lookup_malformed', { row: 'no id' });
      if (b.start_at == null && b.end_at == null) {
        // Codex C4: an EXPLICIT no-snapshot state established by a successful read (a linked legacy
        // booking whose local time could not be resolved by the 0075 backfill; offering_anomalies()
        // reports these as class=legacy). Recorded as null so the caller can tell it from "missing".
        out.set(b.id, null);
        continue;
      }
      // One timestamp without the other, unparseable values, or an interval that does not run
      // forwards are not a snapshot — the feed must not guess.
      if (b.start_at == null || b.end_at == null) throw new SnapshotLookupError('snapshot_lookup_malformed', { row: b.id, reason: 'partial_snapshot' });
      const s = new Date(b.start_at), e = new Date(b.end_at);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) throw new SnapshotLookupError('snapshot_lookup_malformed', { row: b.id, reason: 'unparseable' });
      if (e.getTime() <= s.getTime()) throw new SnapshotLookupError('snapshot_lookup_malformed', { row: b.id, reason: 'end_not_after_start' });
      out.set(b.id, { start_at: s, end_at: e, timezone: b.timezone || null });
    }
  }
  // Codex C4: every requested linked booking must have been returned. A missing row (a short read,
  // a filtered-out id, a later chunk that came back empty) is an incomplete lookup, not legacy.
  const missing = uniqueIds.filter(id => !out.has(id));
  if (missing.length) throw new SnapshotLookupError('snapshot_lookup_incomplete', { missing: missing.length, first: missing[0] });
  return out;
}

// The one failure answer for a feed: not cacheable, not a calendar.
export function sendFeedUnavailable(res, err) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(503).send('Calendar temporarily unavailable — try again in a moment. (' + ((err && err.message) || 'lookup failed') + ')');
}
