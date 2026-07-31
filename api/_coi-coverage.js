// api/_coi-coverage.js — F5-12 / LG-11b: COI coverage requires a TRUSTED verification state,
// not merely a URL + a user-influenced expiry date. A brand is "covered" for a demo only when:
//   (a) a certificate is on file (default_coi_url), AND
//   (b) its expiry is on/after the demo date, AND
//   (c) verification disposition is 'passed'/'approved' (auto-pass) OR the retailer recorded an
//       explicit audited waiver for that booking.
// pending / flagged / rejected / unknown NEVER silently count as covered.

// SUPERSEDED BY api/_coi-policy.js -- kept as a thin delegation so existing callers keep
// working while there is exactly ONE implementation of the rule.
//
// Codex v6 found that this file (strict) and api/_coi-lib.js (lenient) gave opposite
// answers for the same certificate, and that live routes consumed both. Deleting either
// one would have been a bigger change than the correction warrants; making both call the
// same decision removes the disagreement without moving any caller.
import { coiDecision } from './_coi-policy.js';

export function coiCovered(brand, demoDate, opts = {}) {
  const d = coiDecision(brand, [], demoDate, opts);
  return { covered: d.covered, reason: d.reason };
}
