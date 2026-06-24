// /api/brand-cal?token={brand_session_token} — Read-only iCal feed of all demos
// across every retailer where this brand has activity. Subscribe in Google,
// Apple, or Outlook calendar with the URL.
//
// Pattern mirrors /api/cal (retailer side) but scoped by brand_id from the
// session token. Session token is used directly in the URL since this needs
// to work in calendar apps that don't send custom headers.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
function fold(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 73) {
    out.push((i === 0 ? '' : ' ') + line.slice(i, i + 73));
  }
  return out.join('\r\n');
}

function parseDemoTime(dateStr, timeStr) {
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
  return new Date(Date.UTC(Y, M - 1, D, H + 8, MIN, 0)); // assume PST (UTC-8)
}

async function sb(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
}

export default async function handler(req, res) {
  const token = String((req.query && req.query.token) || '').trim();
  if (!token) {
    res.status(400).send('Missing ?token= parameter. Get your calendar URL from your brand dashboard.');
    return;
  }

  try {
    // Look up brand_id from session token
    const sR = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(token)}&select=brand_id,expires_at`);
    const sess = (await sR.json())[0];
    if (!sess || new Date(sess.expires_at).getTime() < Date.now()) {
      res.status(401).send('Invalid or expired calendar URL. Generate a fresh one from your brand portal.');
      return;
    }
    const brandId = sess.brand_id;

    // Brand info
    const bR = await sb(`brands?id=eq.${encodeURIComponent(brandId)}&select=company_name`);
    const brand = (await bR.json())[0];
    if (!brand) { res.status(404).send('Brand not found'); return; }

    // Demos joined with retailer + venue info
    const dR = await sb(`demos?brand_id=eq.${encodeURIComponent(brandId)}&status=in.(confirmed,completed,pending)&select=*,retailers(name),venues(name,address)&order=demo_date`);
    const demos = await dR.json();

    const now = new Date();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Demohub//Brand calendar feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      fold('X-WR-CALNAME:' + escapeICS(`${brand.company_name} — Demos`)),
      fold('X-WR-CALDESC:' + escapeICS(`All your Demohub demos across every retailer`)),
      'X-WR-TIMEZONE:America/Los_Angeles',
    ];

    (demos || []).forEach(d => {
      const start = parseDemoTime(d.demo_date, d.demo_time);
      if (!start) return;
      const durHours = d.duration_hours || 3;
      const end = new Date(start.getTime() + durHours * 60 * 60 * 1000);
      const retailerName = d.retailers?.name || 'Unknown retailer';
      const venueName = d.venues?.name || '';
      const venueAddr = d.venues?.address || '';
      const summary = `${retailerName}${venueName ? ' · ' + venueName : ''}`;
      const descParts = [];
      if (d.product) descParts.push('Product: ' + d.product);
      if (d.status) descParts.push('Status: ' + d.status);
      descParts.push('Booked via Demohub · demohubhq.com/brand');
      lines.push('BEGIN:VEVENT');
      lines.push('UID:brand-' + d.id + '@demohubhq.com');
      lines.push('DTSTAMP:' + toICSDate(now));
      lines.push('DTSTART:' + toICSDate(start));
      lines.push('DTEND:' + toICSDate(end));
      lines.push(fold('SUMMARY:' + escapeICS(summary)));
      if (venueAddr) lines.push(fold('LOCATION:' + escapeICS(`${venueName}, ${venueAddr}`)));
      else if (venueName) lines.push(fold('LOCATION:' + escapeICS(venueName)));
      lines.push(fold('DESCRIPTION:' + escapeICS(descParts.join('\\n'))));
      lines.push('STATUS:' + (d.status === 'confirmed' ? 'CONFIRMED' : d.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED'));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');

    const body = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="demohub-demos.ics"`);
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).send(body);
  } catch (e) {
    res.status(500).send('Error: ' + (e && e.message ? e.message : e));
  }
}
