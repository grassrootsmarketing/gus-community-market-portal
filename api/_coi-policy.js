// api/_coi-policy.js — THE canonical COI decision. One rule, every consumer.
// ============================================================================
// Codex v6 systemic finding: Demohub had TWO definitions of a valid certificate, and
// live routes disagreed about the same document.
//
//   api/_coi-coverage.js   STRICT   file + expiry + verification status passed/approved
//   api/_coi-lib.js        LENIENT  file + expiry, verification status never consulted
//
// Consumed by live code as:
//   api/book.js            strict    (public brand booking)
//   api/booking.js         lenient   (retailer staff manual booking) — and it does not
//                                     even SELECT coi_verification_status
//   api/coi-status.js      lenient   (retailer status view, verified-brand display)
//   api/coi-enforcement.js lenient   (whether a booking has coverage)
//
// So the same certificate could be refused at the public booking route and accepted by
// staff booking, enforcement and the retailer's own status screen — and brandVerifiedState()
// would render a brand as "verified" while its document sat pending, flagged or REJECTED.
//
// THE CANONICAL RULE, for the closed launch:
//   covered  <=>  a certificate path exists
//             AND an expiry exists and is on/after the demo date
//             AND verification status is exactly 'passed' or 'approved'
//   OR        an explicit, authenticated, audited per-booking waiver on routes that
//             support waivers.
//
// pending / flagged / rejected / missing / unknown / unreadable NEVER display as verified
// and NEVER silently count as covered.
//
// WHY 'unknown' IS KEPT AS A DISTINCT STATE, and why it is not 'covered':
//   A certificate whose expiry we cannot read is not proof of insurance, but neither is it
//   proof of absence. Cancelling and refunding someone's demo because our own parsing failed
//   would be its own defect. So the three-state distinction survives — it is the CONSUMER's
//   licence to warn rather than cancel — but 'unknown' is not coverage and cannot book.
//
// This module is pure. No I/O, no fetch, no environment. It decides on the data it is
// handed, which is what makes the policy matrix test able to feed identical states through
// every consumer and prove they agree.
// ============================================================================

const APPROVED_STATUSES = Object.freeze(['passed', 'approved']);

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const day  = (v) => (v ? String(v).slice(0, 10) : null);

export function isApprovedStatus(status) {
  return APPROVED_STATUSES.includes(norm(status));
}

// The single decision. Returns a structured verdict rather than a boolean so callers can
// render an accurate reason without re-deriving one and drifting apart again.
//
//   covered : boolean  — may this brand be booked / counted as insured for demoDate?
//   state   : 'covered' | 'not_verified' | 'expired' | 'unknown' | 'missing' | 'waived'
//   reason  : short machine-readable string, safe to log
export function coiDecision(brand, coiRecords, demoDate, opts = {}) {
  const b  = brand || {};
  const dd = day(demoDate);
  if (!dd) return { covered: false, state: 'missing', reason: 'no_demo_date' };

  // An explicit per-booking waiver, recorded by an authenticated retailer, outranks the
  // document state. It is auditable and deliberate, which is exactly what distinguishes it
  // from the lenient rule this module replaces.
  if (opts.waived === true) return { covered: true, state: 'waived', reason: 'retailer_waived' };

  const hasBrandDoc = !!b.default_coi_url;
  const records = Array.isArray(coiRecords) ? coiRecords : [];
  const coiRecs = records.filter((r) => {
    if (!r) return false;
    const dt = norm(r.doc_type);
    return dt === 'coi' || dt === 'certificate_of_insurance' || dt === 'insurance';
  });

  if (!hasBrandDoc && coiRecs.length === 0) {
    return { covered: false, state: 'missing', reason: 'no_certificate' };
  }

  // VERIFICATION STATUS IS CHECKED BEFORE EXPIRY, deliberately.
  // A rejected certificate with a valid expiry date must not report 'expired' or
  // 'covered' — it must report that it was rejected. The lenient rule never reached this
  // question at all, which is how a rejected document could count as coverage.
  const status = norm(b.coi_verification_status);
  if (!isApprovedStatus(status)) {
    return { covered: false, state: 'not_verified', reason: `not_verified(${status || 'none'})` };
  }

  // Expiry. The brand-level document and any compliance record are both acceptable
  // sources; an unreadable expiry yields 'unknown', never coverage.
  let sawUndated = false;
  const candidates = [];
  if (hasBrandDoc) candidates.push(day(b.default_coi_expires));
  for (const r of coiRecs) candidates.push(day(r.expires_at));

  for (const exp of candidates) {
    if (!exp) { sawUndated = true; continue; }
    if (exp >= dd) return { covered: true, state: 'covered', reason: 'verified' };
  }

  if (sawUndated) return { covered: false, state: 'unknown', reason: 'no_readable_expiry' };
  return { covered: false, state: 'expired', reason: 'expired' };
}

// Convenience wrappers so consumers read naturally without re-implementing the rule.
export function coiCovered(brand, coiRecords, demoDate, opts = {}) {
  return coiDecision(brand, coiRecords, demoDate, opts).covered === true;
}

// What the retailer UI should show. 'covered' and 'waived' are the only states that may
// ever render as insured.
export function coiDisplayState(brand, coiRecords, demoDate, opts = {}) {
  return coiDecision(brand, coiRecords, demoDate, opts).state;
}
