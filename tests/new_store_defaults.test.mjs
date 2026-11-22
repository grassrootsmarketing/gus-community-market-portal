// tests/new_store_defaults.test.mjs (Codex brand-walk order item 5, 2026-11-22): new store defaults are written inside
// the provisioning transaction (migration 0124), never patched in after it committed.
// Offline: the migration text against the application's own constants, and the route's wiring.
// With SB_URL / SB_KEY for demohub-rebuild-check also: a fresh provision, a retry, and that existing stores are untouched.
import { readFileSync } from 'node:fs';
import { REFUNDABLE_CANCELLATION_POLICY } from '../api/_refund-cutoff.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

const mig = readFileSync('supabase/migrations/0124_new_store_defaults.sql', 'utf8');
const route = readFileSync('api/retailer-signup.js', 'utf8');
ok('1a. the function and the column default carry the 72-hour sentence of the application, character for character', mig.split(`'${REFUNDABLE_CANCELLATION_POLICY}'`).length - 1 === 2);
ok('1b. settings are created with a $20 fee and 14 days of notice in the same transaction', /INSERT INTO settings \(retailer_id, demo_fee, demo_duration, advance_booking_days\)\s+VALUES \(v_rid, 20, 180, 14\)/.test(mig));
ok('1c. the refund setting is written with its sentence', /cancellation_mode, cancellation_policy\)/.test(mig) && /'refundable',/.test(mig));
ok('1d. the idempotent return for an existing email is kept, before any insert', mig.indexOf('already := true') > 0 && mig.indexOf('already := true') < mig.indexOf('INSERT INTO retailers'));
ok('1e. the migration updates no existing store', !/^\s*UPDATE\s+(public\.)?(retailers|settings)\b/im.test(mig));
ok('2a. the route no longer patches defaults after the transaction', !/applyNewStoreDefaults/.test(route) && !/advance_booking_days: 14, demo_fee: 20/.test(route));
ok('2b. the store admin pre-fills the fee of a new location from the settings of the store', /window\.state\.settings && window\.state\.settings\.demo_fee/.test(readFileSync('r/gus/admin/index.html', 'utf8')));

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (SB && KEY && SB.includes('tileejdviuvijumjeplv')) {
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const call = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: H }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
  const provision = (email, name) => call('rpc/provision_verified_retailer', { method: 'POST', body: JSON.stringify({ p_email: email, p_store_name: name, p_phone: '555-0173', p_contact_name: 'Fixture Owner', p_store_count: 1 }) });
  const remove = async (id) => { for (const t of ['admin_sessions', 'retailer_admins', 'settings']) await call(`${t}?retailer_id=eq.${id}`, { method: 'DELETE' }); await call(`retailers?id=eq.${id}`, { method: 'DELETE' }); };
  const email = `nsd-${Date.now().toString(36)}@fixture.test`;
  const others = await call('settings?select=retailer_id,demo_fee,advance_booking_days&order=retailer_id.asc&limit=200');
  const p1 = await provision(email, 'Defaults Fixture Market');
  const row = Array.isArray(p1.body) ? p1.body[0] : p1.body;
  const rid = row && row.retailer_id;
  const created = [];
  try {
    const st = (await call(`settings?retailer_id=eq.${rid}&select=demo_fee,advance_booking_days,demo_duration`)).body || [];
    const rt = (await call(`retailers?id=eq.${rid}&select=cancellation_mode,cancellation_policy`)).body || [];
    ok('3a. a fresh store has one settings row: $20, 14 days', p1.ok && row.already === false && st.length === 1 && Number(st[0].demo_fee) === 20 && st[0].advance_booking_days === 14, JSON.stringify({ p1: p1.status, st }));
    ok('3b. and the refundable setting with the 72-hour sentence', rt.length === 1 && rt[0].cancellation_mode === 'refundable' && rt[0].cancellation_policy === REFUNDABLE_CANCELLATION_POLICY, JSON.stringify(rt).slice(0, 200));
    await call(`settings?retailer_id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({ demo_fee: 0, advance_booking_days: 3 }) });
    const p2 = await provision(email, 'Defaults Fixture Market');
    const row2 = Array.isArray(p2.body) ? p2.body[0] : p2.body;
    const st2 = (await call(`settings?retailer_id=eq.${rid}&select=demo_fee,advance_booking_days`)).body || [];
    const count = (await call(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id`)).body || [];
    ok('3c. a retried sign-up returns the same store and leaves the settings the owner chose alone', p2.ok && row2.already === true && row2.retailer_id === rid && count.length === 1 && Number(st2[0].demo_fee) === 0 && st2[0].advance_booking_days === 3, JSON.stringify({ row2, st2 }));
    const both = await Promise.all([1, 2].map(() => provision('c-' + email, 'Concurrent Fixture Market')));
    const made = (await call(`retailers?billing_email=eq.${encodeURIComponent('c-' + email)}&select=id`)).body || [];
    created.push(...made.map(m => m.id));
    const setRows = made.length ? ((await call(`settings?retailer_id=in.(${made.map(m => m.id).join(',')})&select=retailer_id,demo_fee,advance_booking_days`)).body || []) : [];
    ok('3d. two sign-ups at once: every store that exists has its complete defaults (none is half made)', both.some(b => b.ok) && made.length >= 1 && setRows.length === made.length && setRows.every(s => Number(s.demo_fee) === 20 && s.advance_booking_days === 14), JSON.stringify({ made: made.length, setRows }));
    const after = await call('settings?select=retailer_id,demo_fee,advance_booking_days&order=retailer_id.asc&limit=200');
    const beforeMap = new Map((others.body || []).map(s => [s.retailer_id, s.demo_fee + '|' + s.advance_booking_days]));
    ok('3e. the settings of every other store are unchanged', (after.body || []).filter(s => beforeMap.has(s.retailer_id)).every(s => beforeMap.get(s.retailer_id) === s.demo_fee + '|' + s.advance_booking_days));
  } finally {
    for (const id of [rid, ...created]) if (id) await remove(id);
  }
} else console.log('  (database part skipped: SB_URL / SB_KEY for demohub-rebuild-check not set)');

console.log(`\nnew store defaults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
