// tests/admin_cancel_wiring.test.mjs
//
// OFFLINE wiring test for the shipped retailer-admin Cancel/refund flow in r/gus/admin/index.html
// (Codex C3 close-out). Calling the route directly with a hand-supplied booking ID is not enough —
// this asserts the SHIPPED UI sends the right identifier and honors the partial-failure signal.
//
// Proves:
//   1. the admin demo model preserves demos.booking_id (separate from the demo id);
//   2. the Cancel button carries booking_id and never the demo id; the click handler forwards it;
//      cancelDemoConfirm posts booking_id; a demo with no booking_id shows no cancel control;
//   4. a demo_cancelled:false response cannot render the normal green success toast;
//   5. the refund copy matches the backend vocabulary ('submitted', not 'issued').
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const html = readFileSync(resolve('r/gus/admin/index.html'), 'utf8');
const slice = (from, to, n = 2500) => {
  const i = html.indexOf(from); if (i < 0) return '';
  const j = to ? html.indexOf(to, i) : -1;
  return html.slice(i, j > i ? j + to.length : i + n);
};

console.log('\n— admin cancel/refund wiring —');

// 1. demo model preserves booking_id
{
  const mapping = slice('window.state.demos = (data.demos', '}));');
  check('the admin demo model preserves demos.booking_id', /booking_id:\s*d\.booking_id/.test(mapping), 'mapping missing booking_id');
}

// 2. Cancel button + click handler + cancelDemoConfirm use booking_id, never the demo id
{
  // the expression now starts with the Cancellation pending pill (0106/0107); the whole assignment is selected
  const cancelBtn = slice('const cancelBtn = ', 'js-reschedule-demo');
  check('the Cancel button carries data-booking-id from d.booking_id',
    /data-booking-id="'\s*\+\s*escapeHtml\(String\(d\.booking_id\)\)/.test(cancelBtn), 'cancel button not keyed on booking_id');
  check('the Cancel button does NOT use the demo id (d.id) as its identifier',
    !/js-cancel-demo[^]*?data-id="'\s*\+\s*escapeHtml\(String\(d\.id/.test(cancelBtn), 'cancel button still references d.id');
  check('a demo with no booking_id shows no cancel control',
    /:\s*\(d\.booking_id/.test(cancelBtn) && cancelBtn.includes('cancelled or refunded here'), 'no booking-less guard');

  const handler = slice("querySelectorAll('.js-cancel-demo')", ';', 400);
  check('the click handler forwards dataset.bookingId', /cancelDemoConfirm\(\s*b\.dataset\.bookingId/.test(handler), handler.slice(0, 160));

  const fn = slice('async function cancelDemoConfirm(', 'window._coiPending');
  check('cancelDemoConfirm takes a bookingId parameter', /async function cancelDemoConfirm\(\s*bookingId/.test(fn));
  check('cancelDemoConfirm posts booking_id (its param), not a demo id',
    /const body = \{ booking_id: bookingId, action: 'cancel'/.test(fn) && /body:\s*JSON\.stringify\(body\)/.test(fn) && !/booking_id:\s*demoId/.test(fn), fn.slice(0, 120));
}

// 4. demo_cancelled:false cannot show the green success toast
{
  const fn = slice('async function cancelDemoConfirm(', 'window._coiPending');
  check('cancelDemoConfirm branches on demo_cancelled === false', /j\.demo_cancelled\s*===\s*false/.test(fn));
  // the success toast must live in the ELSE branch (after the demo_cancelled===false handling)
  const falseIdx = fn.indexOf('demo_cancelled === false');
  const successIdx = fn.indexOf("'success'");
  check('the success toast is gated behind the demo_cancelled check (not shown on partial completion)',
    falseIdx > -1 && successIdx > falseIdx, `falseIdx=${falseIdx} successIdx=${successIdx}`);
  // the partial-completion branch must be an error/warning toast, not success
  const partialBranch = fn.slice(falseIdx, successIdx > falseIdx ? successIdx : falseIdx + 400);
  check('the demo_cancelled:false branch shows an error/warning toast', /,\s*'error'\)/.test(partialBranch), partialBranch.slice(0, 160));
}

// 5. refund copy uses the backend vocabulary
{
  const fn = slice('async function cancelDemoConfirm(', 'window._coiPending');
  check("cancelDemoConfirm handles refund_status 'submitted'", /refund_status\s*===\s*'submitted'/.test(fn));
  check("cancelDemoConfirm no longer mislabels a refund as 'issued'", !/refund_status\s*===\s*'issued'/.test(fn));
}

// 6. (2026-10-18) the 72-hour rule: the cancel dialog offers "Refund the brand anyway" and posts it as force_refund;
//    the Policies radios carry the two values the server reads; saveBookingPrefs never writes the legacy value.
{
  const fn = slice('async function cancelDemoConfirm(', 'window._coiPending');
  check('the cancel dialog offers a visible "Refund the brand anyway" checkbox', /Refund the brand anyway/.test(fn) && /id="cancelRefundAnyway"/.test(fn), fn.slice(0, 120));
  check('the checkbox is unticked by default (force_refund false in the fresh form state before the dialog opens)', /force_refund: false/.test(fn) && fn.indexOf('force_refund: false') < fn.indexOf('DhModal.confirm('));
  check('cancelDemoConfirm posts force_refund from that choice, as a boolean, only for a brand-requested cancel', /body\.force_refund = fm\.force_refund === true/.test(fn) && fn.indexOf('body.force_refund = fm.force_refund === true') > fn.indexOf("if (fm.category === 'brand_requested')"), fn.slice(0, 160));
  check('the dialog explains the 72-hour rule in plain words', /at least 72 hours after they asked/.test(fn) && /inside 72 hours the fee stays with you/.test(fn));
  check('the dialog tells the store the hours between the request and the demo (demoHoursAway from the request time)', /demoHoursAway\(fm\.dateStr, fm\.timeStr, /.test(html) && /function demoHoursAway\(/.test(html) && /function demoStartMs\(/.test(html));
  // Codex RC-1 / RC-3 (2026-10-18): the category is a required structured choice, the request time is entered, a
  // backdated request needs a note, an override needs a reason; the dialog validates before posting.
  check('the dialog asks WHY with two radios: the brand asked (brand_requested) or the store cannot host (store_caused)', /name="cancelCategory" value="brand_requested"/.test(fn) && /name="cancelCategory" value="store_caused"/.test(fn) && /The brand asked to cancel/.test(fn) && /host it/.test(fn));
  check('no category is preselected and a missing category stops the cancel with a toast, nothing posted', /category: null/.test(fn) && /Pick why the demo is being cancelled/.test(fn) && fn.indexOf('Pick why the demo is being cancelled') < fn.indexOf("fetch('/api/booking-action'"));
  check('the brand-requested branch asks when the brand asked (datetime-local, defaulting to now) and posts requested_at as ISO', /type="datetime-local" id="cancelRequestedAt"/.test(fn) && /localDateTimeValue\(new Date\(\)\)/.test(fn) && /body\.requested_at = reqDate\.toISOString\(\)/.test(fn));
  check('a request more than a day old needs a note, posted as backdate_note', /id="cancelBackdateNote"/.test(fn) && /body\.backdate_note = /.test(fn) && /more than a day ago/.test(fn));
  check('Refund anyway needs a reason, posted as override_reason', /id="cancelOverrideReason"/.test(fn) && /body\.override_reason = /.test(fn) && /Give a short reason for refunding the brand anyway/.test(fn));
  check('the store-caused choice says the brand is refunded in full', /refunded in full/.test(fn));
  check('the toast distinguishes submitted (store cancelled), inside_cutoff, non_refundable and under_review outcomes', /refund_reason === 'store_caused'/.test(fn) && /refund_status === 'under_review'/.test(fn) && /under review by Demohub/.test(fn));
  check('the dialog posts category with the booking id', /const body = \{ booking_id: bookingId, action: 'cancel', category: fm\.category \}/.test(fn));
  check("the toast explains a pending_manual outcome by refund_reason (inside_cutoff / non_refundable)", /refund_reason === 'inside_cutoff'/.test(fn) && /refund_reason === 'non_refundable'/.test(fn));
  const card = html.slice(html.indexOf('id="cancellationPolicyCard"'), html.indexOf('id="demoPolicyCard"'));
  check('the Policies radios are refundable / non_refundable, the values api/_refund-cutoff.js reads', /name="cancellationMode" value="refundable" id="cancelRefund72"/.test(card) && /name="cancellationMode" value="non_refundable" id="cancelNonRefundable"/.test(card));
  check('the refundable radio is worded as the 72-hour rule and recommended', /Refund if cancelled 72 hours ahead/.test(card) && /RECOMMENDED/.test(card));
  check('the retired 14_day_refund value and 14-day wording are gone from the markup', !/value="14_day_refund"/.test(html) && !/14-day refund window/.test(html) && !/within 14 days of the booking date/.test(html));
  const save = slice('async function saveBookingPrefs()', 'DhModal.toast(\'Booking settings saved\'');
  check("saveBookingPrefs writes 'refundable' or 'non_refundable', never the legacy value", /'non_refundable' : 'refundable'/.test(save) && !/14_day_refund/.test(save), save.slice(0, 200));
  check('saveBookingPrefs sends the sentence for the mode in the same PATCH (the server generates and validates it)', /payload\.cancellation_policy = cancellationSentenceFor\(mode\)/.test(save));
  check('the card shows the sentence brands sign (renderCancellationSentence into #cancellationPolicySentence)', /id="cancellationPolicySentence"/.test(card) && /function renderCancellationSentence\(\)/.test(html));
  check('the non-refundable sentence in the admin is the one api/_refund-cutoff.js exports', (() => { const a = html.match(/CANCEL_POLICY_NON_REFUNDABLE = '([^']+)'/); const lib = readFileSync(resolve('api/_refund-cutoff.js'), 'utf8').match(/NON_REFUNDABLE_CANCELLATION_POLICY = '([^']+)'/); return !!a && !!lib && a[1] === lib[1]; })());
}

console.log(`\nadmin cancel wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
