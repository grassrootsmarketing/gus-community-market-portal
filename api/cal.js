// /api/cal?slug={retailer-slug} — Read-only iCalendar feed (RFC 5545) of all confirmed
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
// helper (api/_local-time.js) — correct PDT/PST, no fixed UTC-8. A missing/unparseable time keeps the
// feed's long-standing 11:00 default; a date that cannot be resolved (impossible date, DST gap) is
// dropped from the feed rather than guessed.
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
    res.status(400).send('Missing or invalid ?slug= parameter');
    return;
  }

  try {
    // Look up retailer
    const rR = await fetch(`${_b.supabaseUrl}/rest/v1/retailers?slug=eq.${encodeURIComponent(slug)}&select=id,name,cal_feed_key,timezone`, {
      headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
    });
    const retailers = await rR.json();
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) { res.status(404).send('Retailer not found'); return; }
    // Secret feed key required. The slug is public (it's in booking links), so the key is
    // what keeps this calendar private. Deny if the retailer has no key or it doesn't match.
    const _expected = retailer.cal_feed_key || '';
    const _match = _expected.length > 0 && feedKey.length === _expected.length &&
      (function () { let d = 0; for (let i = 0; i < _expected.length; i++) d |= feedKey.charCodeAt(i) ^ _expected.charCodeAt(i); return d === 0; })();
    if (!_match) { res.status(401).send('This calendar feed requires the private link from your Demohub admin (Settings -> Calendar feed).'); return; }

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

    // Phase F: venue filter — accept UUID or exact venue name (case-insensitive)
    let filteredVenueName = null;
    if (venueParam) {
      const wantId = /^[0-9a-f-]{36}$/i.test(venueParam) ? venueParam : null;
      const wantName = venueParam.toLowerCase();
      const match = (venues || []).find(v => (wantId && v.id === wantId) || (!wantId && (v.name || '').toLowerCase() === wantName));
      if (match) {
        filteredVenueName = match.name;
        demos = (demos || []).filter(d => d.venue_id === match.id);
      } else {
        // Venue param supplied but no match — return empty calendar rather than 404
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
      fold('X-WR-CALNAME:' + escapeICS(`${retailer.name}${filteredVenueName ? ' — ' + filteredVenueName : ''} — Demos`)),
      fold('X-WR-CALDESC:' + escapeICS(`Confirmed demos at ${retailer.name}${filteredVenueName ? ' — ' + filteredVenueName : ''}, powered by Demohub`)),
      'X-WR-TIMEZONE:' + tz,
    ];

    // Codex B-04: the ACCEPTED occurrence is the booking's snapshot (start_at/end_at/timezone,
    // 0074/0076). A retailer changing its timezone setting must not move an existing appointment.
    // Only a legacy demo without a usable snapshot falls back to reconstructing the time.
    const snapById = {};
    {
      const ids = (demos || []).map(d => d.booking_id).filter(Boolean);
      if (ids.length) {
        const bR = await fetch(`${_b.supabaseUrl}/rest/v1/bookings?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,start_at,end_at,timezone`, {
          headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` },
        });
        const rows = bR.ok ? await bR.json() : [];
        (rows || []).forEach(b => { if (b.start_at && b.end_at) snapById[b.id] = b; });
      }
    }
    (demos || []).forEach(d => {
      const snap = d.booking_id ? snapById[d.booking_id] : null;
      const start = snap ? new Date(snap.start_at) : parseDemoTime(d.demo_date, d.demo_time, tz);
      if (!start || Number.isNaN(start.getTime())) return;
      const durHours = d.duration_hours || 3;
      const end = snap ? new Date(snap.end_at) : new Date(start.getTime() + durHours * 60 * 60 * 1000);
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
    // Light caching — calendar apps poll every few hours
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).send('Error: ' + (e && e.message ? e.message : e));
  }
}
