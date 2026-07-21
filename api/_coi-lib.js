// Shared COI status + cutoff helpers for the enforcement cron and the retailer
// COI-status endpoint. Pure functions, no I/O, single source of truth (work order Phase 2).

// A3/A4: is the brand covered for a demo on `demoDate` (YYYY-MM-DD)? Covered if EITHER
//  (a) brand-level default COI present AND (default_coi_expires null OR >= demoDate), OR
//  (b) any compliance COI record whose expires_at >= demoDate (null expiry counts as covered).
// This function only evaluates the data it is handed; the caller owns fail-safe behavior
// on unreadable/ambiguous data (never cancel on uncertainty).
// Three states, not two. A certificate with no readable expiry is NOT proof of
// current insurance, but it is also not proof of absence - refunding a demo
// because our OCR failed would be wrong. 'unknown' keeps those two apart so the
// caller can warn without cancelling.
//
//   'covered' - certificate on file and valid on the demo date
//   'unknown' - certificate on file but no expiry we can trust
//   'missing' - nothing on file
export function coiCoverageState(brand, coiRecords, demoDate) {
  const dd = String(demoDate || '').slice(0, 10);
  if (!dd) return 'missing';
  let sawUndated = false;

  if (brand && brand.default_coi_url) {
    const exp = brand.default_coi_expires ? String(brand.default_coi_expires).slice(0, 10) : null;
    if (!exp) sawUndated = true;
    else if (exp >= dd) return 'covered';
  }

  if (Array.isArray(coiRecords)) {
    for (const r of coiRecords) {
      if (!r) continue;
      const dt = String(r.doc_type || '').toLowerCase();
      if (dt !== 'coi' && dt !== 'certificate_of_insurance' && dt !== 'insurance') continue;
      const exp = r.expires_at ? String(r.expires_at).slice(0, 10) : null;
      if (!exp) { sawUndated = true; continue; }
      if (exp >= dd) return 'covered';
    }
  }

  return sawUndated ? 'unknown' : 'missing';
}

// Kept for callers that only need a yes/no. Deliberately strict: 'unknown' is
// not 'covered'. Anything that can cancel a demo must use coiCoverageState().
export function hasCurrentCoi(brand, coiRecords, demoDate) {
  return coiCoverageState(brand, coiRecords, demoDate) === 'covered';
}

// A2: cutoff = 00:00 on demoDate in the retailer's timezone, minus 72h. Returns a UTC Date.
// Uses Intl (stdlib) to resolve the UTC instant of local midnight; no date libraries.
export function coiCutoff(demoDate, retailerTimezone) {
  const tz = retailerTimezone || 'America/Los_Angeles';
  const dd = String(demoDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dd)) return null;
  const [y, m, d] = dd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const loc = tzParts(guess, tz);
  const asUtcOfLocal = Date.UTC(loc.year, loc.month - 1, loc.day, loc.hour, loc.minute, loc.second);
  const offset = asUtcOfLocal - guess;
  const localMidnightUtc = guess - offset;
  return new Date(localMidnightUtc - 72 * 3600 * 1000);
}

// Local midnight (UTC instant) of demoDate in tz — used to derive the 7-day reminder threshold.
export function localMidnightUtc(demoDate, retailerTimezone) {
  const c = coiCutoff(demoDate, retailerTimezone);
  return c ? new Date(c.getTime() + 72 * 3600 * 1000) : null;
}

function tzParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of dtf.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  return { year: +p.year, month: +p.month, day: +p.day, hour, minute: +p.minute, second: +p.second };
}
