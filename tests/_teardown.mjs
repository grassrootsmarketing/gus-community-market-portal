// tests/_teardown.mjs (2026-10-30, connected checkout round 3): removes the rows a route suite created on
// demohub-rebuild-check, so a suite that drives the real refund worker with SIMULATED Stripe ids (tests/connected_settlement.test.mjs,
// tests/connected_checkout.test.mjs) does not leave refund requests behind that every later worker run on the test project
// retries against ids Stripe has never seen. The live rehearsal of 2026-10-30 found four such rows (a 'pi_round_...' request and
// three pending settlements) making the worker answer 500 on demohub-rebuild-check; this helper and the suites' finally blocks
// are the fix. Refuses any project other than demohub-rebuild-check. Deletion order follows the foreign keys (RESTRICT first).
const TEST_REF = 'tileejdviuvijumjeplv';

export async function teardownRetailerFixtures({ sbUrl, sbKey, retailerIds = [], brandIds = [], deriveBrands = true, log = () => {} }) {
  if (!sbUrl || !sbUrl.includes(TEST_REF)) throw new Error('teardownRetailerFixtures: refusing, not demohub-rebuild-check');
  const H = { apikey: sbKey, Authorization: 'Bearer ' + sbKey, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const call = async (path, opts = {}) => {
    const r = await fetch(`${sbUrl}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
    if (!r.ok) throw new Error(`${path.split('?')[0]}: ${(j && j.message) || t || r.status}`);
    return j;
  };
  const chunks = (arr, n = 40) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const list = (v) => `in.(${v.join(',')})`;
  const del = async (table, column, ids) => { let n = 0; for (const c of chunks(ids)) { const rows = await call(`${table}?${column}=${list(c)}`, { method: 'DELETE' }); n += Array.isArray(rows) ? rows.length : 0; } if (n) log(`  deleted ${n} ${table}`); return n; };
  const counts = {};
  const retailers = [...new Set(retailerIds.filter(Boolean))];
  if (retailers.length === 0 && brandIds.length === 0) return counts;

  let bookings = [], groups = [], ops = [], reqs = [], brands = [...new Set(brandIds.filter(Boolean))];
  if (retailers.length) {
    for (const c of chunks(retailers)) {
      bookings.push(...(await call(`bookings?retailer_id=${list(c)}&select=id,brand_id`)));
      groups.push(...(await call(`payment_groups?retailer_id=${list(c)}&select=id`)).map(g => g.id));
    }
    if (deriveBrands) {
      const candidate = [...new Set(bookings.map(b => b.brand_id).filter(Boolean))];
      for (const c of chunks(candidate)) brands.push(...(await call(`brands?id=${list(c)}&email=like.*@fixture.test&select=id`)).map(b => b.id));
      brands = [...new Set(brands)];
    }
    const bookingIds = bookings.map(b => b.id);
    for (const c of chunks(bookingIds)) {
      ops.push(...(await call(`refund_operations?booking_id=${list(c)}&select=id`)).map(o => o.id));
      reqs.push(...(await call(`refund_requests?booking_id=${list(c)}&select=id`)).map(o => o.id));
    }
    // RESTRICT children first, then the groups, then the retailers (which cascade bookings, venues, settings, admins, tokens).
    if (ops.length) counts.refund_review_actions = await del('refund_review_actions', 'refund_operation_id', ops);
    if (groups.length) counts.cases_by_group = await del('reconciliation_cases', 'payment_group_id', groups);
    if (reqs.length) counts.cases_by_request = await del('reconciliation_cases', 'refund_request_id', reqs);
    if (ops.length) counts.cases_by_operation = await del('reconciliation_cases', 'refund_operation_id', ops);
    if (bookingIds.length) {
      counts.refund_requests = await del('refund_requests', 'booking_id', bookingIds);
      counts.refund_operations = await del('refund_operations', 'booking_id', bookingIds);
      counts.booking_fulfillments = await del('booking_fulfillments', 'booking_id', bookingIds);
      counts.booking_operations = await del('booking_operations', 'booking_id', bookingIds);
    }
    counts.booking_code_redemptions = await del('booking_code_redemptions', 'retailer_id', retailers);
    counts.notification_deliveries = await del('notification_deliveries', 'retailer_id', retailers);
    counts.notification_events = await del('notification_events', 'retailer_id', retailers);
    if (groups.length) {
      counts.payment_allocations = await del('payment_allocations', 'payment_group_id', groups);
      counts.payment_attempts = await del('payment_attempts', 'payment_group_id', groups);
      counts.booking_fulfillments_by_group = await del('booking_fulfillments', 'payment_group_id', groups);
      counts.payment_groups = await del('payment_groups', 'id', groups);
    }
    counts.brand_sessions = await del('brand_sessions', 'retailer_id', retailers);
    counts.brand_tokens = await del('brand_tokens', 'retailer_id', retailers);
    counts.retailers = await del('retailers', 'id', retailers);
  }
  // A fixture brand goes only when nothing else still points at it (it may have booked at a retailer this call did not own).
  const keep = [];
  for (const b of brands) {
    const still = (await call(`bookings?brand_id=eq.${b}&select=id&limit=1`)).length + (await call(`payment_groups?brand_id=eq.${b}&select=id&limit=1`)).length;
    if (still) { keep.push(b); continue; }
    await del('notification_events', 'brand_id', [b]);
    counts.brands = (counts.brands || 0) + await del('brands', 'id', [b]);
  }
  if (keep.length) log(`  kept ${keep.length} brand(s) still referenced elsewhere`);
  return counts;
}
