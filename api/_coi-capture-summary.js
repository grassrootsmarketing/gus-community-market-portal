// api/_coi-capture-summary.js — the reviewer-facing summary of what a COI approval's auto-capture
// sweep did to each held booking (Codex P-1 / P-3, follow-up F-2, 2026-09-17).
//
// Pure: derives every sentence from the ACTUAL per-booking results. It never promises a
// reconciliation case that was not recorded, and never implies one exists for an entry the sweep
// did not process (error / not_attempted) — those have no case by construction.
//
// holdResults: [{ booking_id, outcome, applied, case_id, case_recorded, error }]
//   outcome 'captured' + applied true   -> charged and ledgered (clean; not mentioned)
//   outcome 'captured' + applied false  -> charged, ledger not applied yet (needs a case)
//   outcome 'uncertain'                 -> payment outcome unknown (needs a case)
//   outcome 'not_captured'              -> Stripe says nothing was charged (clean; not mentioned)
//   outcome 'error' | 'not_attempted'   -> this approval did not process the hold (no case exists)
export function coiCaptureSummary(holdResults) {
  const holds = Array.isArray(holdResults) ? holdResults.filter(Boolean) : [];
  const unapplied = holds.filter(h => h.outcome === 'captured' && h.applied === false);
  const uncertain = holds.filter(h => h.outcome === 'uncertain');
  const unprocessed = holds.filter(h => h.outcome === 'error' || h.outcome === 'not_attempted');
  if (!unapplied.length && !uncertain.length && !unprocessed.length) return { attention: false, message: undefined };

  const parts = [];
  if (unapplied.length) parts.push(`${unapplied.length} held booking(s) WERE charged but the ledger could not be updated yet`);
  if (uncertain.length) parts.push(`${uncertain.length} held booking(s) have an UNKNOWN payment outcome — the brand may have been charged`);
  if (unprocessed.length) parts.push(`${unprocessed.length} held booking(s) could not be processed by this approval`);
  let message = parts.join('; ') + '.';
  if (unapplied.length || uncertain.length) message += ' Do not charge again or ask them to rebook.';

  // Case wording: only for the entries that are SUPPOSED to have a case, and only what is true.
  const needCase = [...unapplied, ...uncertain];
  if (needCase.length) {
    const missing = needCase.filter(h => !(h.case_recorded === true && h.case_id));
    if (!missing.length) message += needCase.length === 1 ? ' A reconciliation case tracks it.' : ' A reconciliation case tracks each of those.';
    else if (missing.length === needCase.length) message += ` A reconciliation case could NOT be recorded for ${needCase.length === 1 ? 'it' : 'any of them'} — contact support with the booking id(s) below.`;
    else message += ` A reconciliation case was recorded for ${needCase.length - missing.length} of them and could NOT be recorded for ${missing.length} — contact support with the booking id(s) below.`;
  }
  if (unprocessed.length) {
    message += ` No reconciliation case exists for the ${unprocessed.length} unprocessed booking(s): nothing was attempted for them by this approval, which says nothing about whether their payment was ever captured — check them in the retailer admin.`;
  }
  return { attention: true, message };
}
