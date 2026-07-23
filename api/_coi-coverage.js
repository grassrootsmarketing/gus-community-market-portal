// api/_coi-coverage.js — F5-12 / LG-11b: COI coverage requires a TRUSTED verification state,
// not merely a URL + a user-influenced expiry date. A brand is "covered" for a demo only when:
//   (a) a certificate is on file (default_coi_url), AND
//   (b) its expiry is on/after the demo date, AND
//   (c) verification disposition is 'passed'/'approved' (auto-pass) OR the retailer recorded an
//       explicit audited waiver for that booking.
// pending / flagged / rejected / unknown NEVER silently count as covered.

const APPROVED = new Set(['passed', 'approved']);

export function coiCovered(brand, demoDate, opts = {}) {
  const b = brand || {};
  const dd = String(demoDate || '').slice(0, 10);
  if (!dd) return { covered: false, reason: 'no_demo_date' };
  if (opts.waived === true) return { covered: true, reason: 'retailer_waived' };
  if (!b.default_coi_url) return { covered: false, reason: 'no_certificate' };
  const status = String(b.coi_verification_status || '').toLowerCase();
  if (!APPROVED.has(status)) return { covered: false, reason: `not_verified(${status || 'none'})` };
  const exp = b.default_coi_expires ? String(b.default_coi_expires).slice(0, 10) : null;
  if (!exp) return { covered: false, reason: 'no_expiry' };
  if (exp < dd) return { covered: false, reason: 'expired' };
  return { covered: true, reason: 'verified' };
}
