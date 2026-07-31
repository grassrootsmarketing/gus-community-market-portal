import { coiDecision } from './_coi-policy.js';

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
// SUPERSEDED: this function used to answer "file + expiry?" WITHOUT consulting
// coi_verification_status, so a pending, flagged or REJECTED certificate counted as
// coverage here while api/book.js refused the very same document. It now delegates to the
// one canonical decision.
//
// The three-state return is preserved because callers depend on the distinction between
// "no cover" and "we cannot read the expiry" -- cancelling a demo because our own parsing
// failed would be its own defect. 'unknown' still never means covered.
export function coiCoverageState(brand, coiRecords, demoDate) {
  const d = coiDecision(brand, coiRecords, demoDate);
  if (d.state === 'covered' || d.state === 'waived') return 'covered';
  if (d.state === 'unknown') return 'unknown';
  // not_verified and expired are hard refusals, not ambiguity: we read the document fine
  // and it does not entitle anyone to book.
  if (d.state === 'not_verified' || d.state === 'expired') return 'missing';
  return 'missing';
}

// Kept for callers that only need a yes/no. Deliberately strict: 'unknown' is not
// 'covered'. Anything that can cancel a demo must use coiCoverageState().
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

// Canonical definition of a "verified" brand. The brand portal shows this to the
// brand and the retailer admin shows it to the store, so it must be one rule.
// Verified = current COI + the identity fields a store needs to trust a stranger.
export function brandVerifiedState(brand, demoDate) {
  const b = brand || {};
  const missing = [];
  const coverage = coiCoverageState(b, [], demoDate || new Date().toISOString().slice(0, 10));
  if (coverage !== 'covered') missing.push('current Certificate of Insurance');
  if (!b.company_name) missing.push('company name');
  if (!b.contact_name) missing.push('contact name');
  if (!b.email) missing.push('email');
  if (!b.phone) missing.push('phone');
  if (!(b.website && String(b.website).trim().length > 4)) missing.push('website');
  if (!b.logo_url) missing.push('logo');
  return { verified: missing.length === 0, missing };
}
