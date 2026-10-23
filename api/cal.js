// /api/cal?slug={retailer-slug}, Read-only iCalendar feed (RFC 5545) of all confirmed
// demos at a retailer. Subscribe in Google Calendar / Apple Calendar / Outlook.
//
// URL pattern: https://demohubhq.com/api/cal?slug=gus
// To use: in Google Cal "From URL", Apple Cal "New Calendar Subscription", or
//         Outlook "Add Calendar from Internet".
//
// Public by design: no auth, but only confirmed demos at the slug are exposed.
// Sensitive fields (contact email, phone, notes) are NOT included.

import { getBinding, sendBindingFailure } from './_env.js';
import { demoStartUtc, safeZone } from './_local-time.js';
let _b = null;   // per-invocation binding; server-side reads use the service key to bypass RLS

// A feed URL opened in a browser (instead of a calendar app) used to answer a bare line of text with no logo and no
// favicon (David, 2026-10-23). Every non-calendar answer is now a small Demohub page: the real logo (the dashboard
// header's mark), the site's font and tokens, one plain sentence. Calendar apps only ever see the status code.
const DEMOHUB_MARK = '<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><defs><radialGradient id="dhOrange" cx="0.36" cy="0.30" r="0.78"><stop offset="0" stop-color="#ff9a5c"/><stop offset="0.45" stop-color="#ed682f"/><stop offset="0.85" stop-color="#b8471a"/><stop offset="1" stop-color="#9a3a13"/></radialGradient></defs><circle cx="36" cy="40" r="18" fill="url(#dhOrange)"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>';
const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function feedNoticeHtml(title, message) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>' + escHtml(title) + ' | Demohub</title>'
    + '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;background:#faf8f5;color:#0d1f12;font-family:"Plus Jakarta Sans",-apple-system,"Segoe UI",sans-serif;line-height:1.5}main{max-width:560px;margin:12vh auto 0;padding:0 20px}.card{background:#fff;border:1px solid #e8e0d5;border-radius:12px;padding:28px 28px 24px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}.brand b{font-size:1.05rem;font-weight:700;color:#0f2c17}h1{font-size:1.25rem;font-weight:600;margin:0 0 8px;color:#1a3a21}p{margin:0;font-size:0.95rem;color:#3a3a36}small{display:block;margin-top:18px;font-size:0.78rem;color:#7a6352}</style></head>'
    + '<body><main><div class="card"><div class="brand">' + DEMOHUB_MARK + '<b>Demohub</b></div><h1>' + escHtml(title) + '</h1><p>' + escHtml(message) + '</p><small>This address is a calendar feed. It is meant to be added to a calendar app, not opened in a browser.</small></div></main></body></html>';
}
function sendFeedNotice(res, status, title, message) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(status).send(feedNoticeHtml(title, message));
}

function pad(n) { return String(n).padStart(2, '0'); }
function toICSDate(d) {
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
         pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
}
function escapeICS(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}
// Fold lines per RFC 5545 (no line > 75 octets)
function fold(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 73) {
    out.push((i === 0 ? '' : ' ') + line.slice(i, i + 73));
  }
  return out.join('\r\n');
}

// The demo's start instant: demo_date + demo_time resolved in the RETAILER's zone by the shared
// helper (api/_local-time.js), correct PDT/PST, no fixed UTC-8. A missing/unparseable time keeps the
// feed's long-standing 11:00 default; a date that cannot be resolved (impossible date, DST gap) is
// dropped from the feed rather than guessed.
import { fetchBookingSnapshots, sendFeedUnavailable } from './_occurrence.js';
function parseDemoTime(dateStr, timeStr, tz) {
  if (!dateStr) return null;
  return demoStartUtc(dateStr, timeStr, tz, { lenientTime: true });
}

export default async function handler(req, res) {
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  const slug = String((req.query && req.query.slug) || '').trim().toLowerCase();
  const venueParam = String((req.query && req.query.venue) || '').trim();
  const feedKey = String((req.query && req.query.key) || '').trim();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    sendFeedNotice(res, 400, 'This feed address is incomplete', 'The link is missing the store it belongs to. Copy it again from Settings in the Demohub admin.');
    return;
  }

  try {
    // Look up retailer
    const rR = await fetch(`${_b.supabaseUrl}/rest/v1/retailers?slug=eq.${encodeURIComponent(slug)}&select=id,name,cal_feed_key,timezone`, {
      headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
    });
    const retailers = await rR.json();
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) { sendFeedNotice(res, 404, 'No store at this address', 'The store in this link does not exist. Copy the feed link again from Settings in the Demohub admin.'); return; }
    // Secret feed key required. The slug is public (it's in booking links), so the key is
    // what keeps this calendar private. Deny if the retailer has no key or it doesn't match.
    const _expected = retailer.cal_feed_key || '';
    const _match = _expected.length > 0 && feedKey.length === _expected.length &&
      (function () { let d = 0; for (let i = 0; i < _expected.length; i++) d |= feedKey.charCodeAt(i) ^ _expected.charCodeAt(i); return d === 0; })();
    if (!_match) { sendFeedNotice(res, 401, 'This feed needs its private link', 'Only the full feed link from the Demohub admin works (Settings, then Staff calendar). Copy it from there; if it was rotated, the old link no longer opens.'); return; }

    // Get all confirmed/completed demos for this retailer + their venue names
    const [dR, vR] = await Promise.all([
      fetch(`${_b.supabaseUrl}/rest/v1/demos?retailer_id=eq.${encodeURIComponent(retailer.id)}&status=in.(confirmed,completed)&select=*&order=demo_date`, {
        headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
      }),
      fetch(`${_b.supabaseUrl}/rest/v1/venues?retailer_id=eq.${encodeURIComponent(retailer.id)}&select=id,name,address`, {
        headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
      }),
    ]);
    let demos = await dR.json();
    const venues = await vR.json();
    const venueById = {};
    (venues || []).forEach(v => { venueById[v.id] = v; });

    // Phase F: venue filter, accept UUID or exact venue name (case-insensitive)
    let filteredVenueName = null;
    if (venueParam) {
      const wantId = /^[0-9a-f-]{36}$/i.test(venueParam) ? venueParam : null;
      const wantName = venueParam.toLowerCase();
      const match = (venues || []).find(v => (wantId && v.id === wantId) || (!wantId && (v.name || '').toLowerCase() === wantName));
      if (match) {
        filteredVenueName = match.name;
        demos = (demos || []).filter(d => d.venue_id === match.id);
      } else {
        // Venue param supplied but no match, return empty calendar rather than 404
        demos = [];
      }
    }

    const now = new Date();
    const tz = safeZone(retailer.timezone);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//Demohub//Calendar feed//EN`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      fold('X-WR-CALNAME:' + escapeICS(`${retailer.name}${filteredVenueName ? ' · ' + filteredVenueName : ''} · Demos`)),
      fold('X-WR-CALDESC:' + escapeICS(`Confirmed demos at ${retailer.name}${filteredVenueName ? ' · ' + filteredVenueName : ''}, powered by Demohub`)),
      'X-WR-TIMEZONE:' + tz,
    ];

    // Codex B-04: the ACCEPTED occurrence is the booking's snapshot (start_at/end_at/timezone,
    // 0074/0076). A retailer changing its timezone setting must not move an existing appointment.
    // Only a legacy demo without a usable snapshot falls back to reconstructing the time.
    // Codex R3: a FAILED snapshot lookup must not become a reconstructed calendar. Chunked,
    // de-duplicated lookup; any failed or malformed chunk answers 503 (no-store) instead.
    let snapById;
    try {
      snapById = await fetchBookingSnapshots(
        (p) => fetch(`${_b.supabaseUrl}/rest/v1/${p}`, { headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` } }),
        (demos || []).map(d => d.booking_id));
    } catch (e) {
      console.error('cal feed snapshot lookup failed:', (e && e.message) || e, e && e.detail);
      return sendFeedUnavailable(res, e);
    }
    (demos || []).forEach(d => {
      const snap = d.booking_id ? snapById.get(d.booking_id) : null;
      // Reconstruction is for a demo with NO linked booking, or a linked booking that genuinely has
      // no snapshot (legacy), both established by a SUCCESSFUL read above.
      const start = snap ? snap.start_at : parseDemoTime(d.demo_date, d.demo_time, tz);
      if (!start || Number.isNaN(start.getTime())) return;
      const durHours = d.duration_hours || 3;
      const end = snap ? snap.end_at : new Date(start.getTime() + durHours * 60 * 60 * 1000);
      const venue = venueById[d.venue_id] || null;
      const venueLabel = venue ? venue.name : '';
      const venueAddr = venue && venue.address ? venue.address : '';
      const summary = `${d.company_name || 'Demo'}${venueLabel ? ' @ ' + venueLabel : ''}`;
      const descParts = [];
      if (d.product) descParts.push('Product: ' + d.product);
      if (d.company_name) descParts.push('Brand: ' + d.company_name);
      if (d.contact_name) descParts.push('Contact: ' + d.contact_name);
      descParts.push('Booked via Demohub · demohubhq.com');
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + d.id + '@demohubhq.com');
      lines.push('DTSTAMP:' + toICSDate(now));
      lines.push('DTSTART:' + toICSDate(start));
      lines.push('DTEND:' + toICSDate(end));
      lines.push(fold('SUMMARY:' + escapeICS(summary)));
      if (venueAddr) lines.push(fold('LOCATION:' + escapeICS(`${venueLabel}, ${venueAddr}`)));
      else if (venueLabel) lines.push(fold('LOCATION:' + escapeICS(venueLabel)));
      lines.push(fold('DESCRIPTION:' + escapeICS(descParts.join('\\n'))));
      lines.push('STATUS:CONFIRMED');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    const body = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${slug}-demos.ics"`);
    // Light caching, calendar apps poll every few hours
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).send(body);
  } catch (e) {
    sendFeedNotice(res, 500, 'The feed could not be built', 'Something went wrong while building this calendar. Try again in a moment.');
  }
}
