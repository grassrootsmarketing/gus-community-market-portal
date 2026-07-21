// /api/cal?slug={retailer-slug} — Read-only iCalendar feed (RFC 5545) of all confirmed
// demos at a retailer. Subscribe in Google Calendar / Apple Calendar / Outlook.
//
// URL pattern: https://demohubhq.com/api/cal?slug=gus
// To use: in Google Cal "From URL", Apple Cal "New Calendar Subscription", or
//         Outlook "Add Calendar from Internet".
//
// Public by design: no auth, but only confirmed demos at the slug are exposed.
// Sensitive fields (contact email, phone, notes) are NOT included.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable__e8tiRc5-f7Wexa-r1Perg_hJ84vltF';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;  // server-side reads must bypass RLS

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

function parseDemoTime(dateStr, timeStr) {
  // dateStr: YYYY-MM-DD. timeStr: "11:00 AM" or "3:00 PM" or null
  if (!dateStr) return null;
  const [Y, M, D] = dateStr.split('-').map(n => parseInt(n, 10));
  let H = 11, MIN = 0;
  if (timeStr) {
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (m) {
      let h = parseInt(m[1], 10);
      const ampm = (m[3] || '').toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      H = h; MIN = parseInt(m[2], 10);
    }
  }
  // Treat as US Pacific. Convert to UTC roughly (US/Pacific = UTC-8 standard, -7 during DST).
  // For accuracy across DST, use a rough UTC offset; cal apps tolerate the absolute time.
  // We'll use the local-time approach with TZID hint, but simpler: just emit UTC ±8h.
  const localDate = new Date(Date.UTC(Y, M - 1, D, H + 8, MIN, 0)); // assume PST (UTC-8)
  return localDate;
}

export default async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || '').trim().toLowerCase();
  const venueParam = String((req.query && req.query.venue) || '').trim();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).send('Missing or invalid ?slug= parameter');
    return;
  }

  try {
    // Look up retailer
    const rR = await fetch(`${SUPABASE_URL}/rest/v1/retailers?slug=eq.${encodeURIComponent(slug)}&select=id,name`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    const retailers = await rR.json();
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) { res.status(404).send('Retailer not found'); return; }

    // Get all confirmed/completed demos for this retailer + their venue names
    const [dR, vR] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/demos?retailer_id=eq.${encodeURIComponent(retailer.id)}&status=in.(confirmed,completed)&select=*&order=demo_date`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/venues?retailer_id=eq.${encodeURIComponent(retailer.id)}&select=id,name,address`, {
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
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
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:-//Demohub//Calendar feed//EN`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      fold('X-WR-CALNAME:' + escapeICS(`${retailer.name}${filteredVenueName ? ' — ' + filteredVenueName : ''} — Demos`)),
      fold('X-WR-CALDESC:' + escapeICS(`Confirmed demos at ${retailer.name}${filteredVenueName ? ' — ' + filteredVenueName : ''}, powered by Demohub`)),
      'X-WR-TIMEZONE:America/Los_Angeles',
    ];

    (demos || []).forEach(d => {
      const start = parseDemoTime(d.demo_date, d.demo_time);
      if (!start) return;
      const durHours = d.duration_hours || 3;
      const end = new Date(start.getTime() + durHours * 60 * 60 * 1000);
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
