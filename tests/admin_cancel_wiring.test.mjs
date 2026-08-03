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
  const cancelBtn = slice('const cancelBtn = cancelled', 'js-reschedule-demo');
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
    /body:\s*JSON\.stringify\(\{\s*booking_id:\s*bookingId/.test(fn) && !/booking_id:\s*demoId/.test(fn), fn.slice(0, 120));
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

console.log(`\nadmin cancel wiring: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
