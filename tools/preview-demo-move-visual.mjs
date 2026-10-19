// tools/preview-demo-move-visual.mjs (2026-10-19, final review request): an authenticated visual pass of the demo-move
// release on the DEPLOYED preview (flag on), at a desktop and a phone width: the store's "Move this demo" dialog (and
// its ask-first mode), the store calendar's detail modal, then a real pending move created through the deployed route
// so the owner's banner and the booker's row render from live data; the move is confirmed through the route at the end.
// Screenshots land in tests/evidence/visual/<sha>-moves/ with a manifest (width, role, page, SHA, overflow flag).
// Test database only (demohub-rebuild-check); sessions minted directly; nothing here touches production.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const PW_ROOT = process.env.PLAYWRIGHT_ROOT; const require = createRequire(PW_ROOT + '/package.json'); const { chromium } = require('playwright');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY, BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim();
if (!SB.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_URL is not demohub-rebuild-check'); process.exit(2); }
const ALIAS = 'https://demohub-booker-preview.vercel.app';
const CHECKOUT = 'C:/Users/David/demohub-demo-move';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', VENUE = 'c1be157f-c9e3-4726-8c9c-cb05ac3f9fd5', STORE_ADMIN = 'david@demohubhq.com';
const BOOKER_EMAIL = 'david+visual@demohubhq.com';
const BOOKING = process.env.MOVE_VISUAL_BOOKING || '828ef203-8817-4496-94ab-a85369d9364d';   // S1's confirmed, paid booking from the matrix run
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 60) + ' ' + r.status + ' ' + t.slice(0, 160)); return j; };
const api = async (path, body, cookie) => { const r = await fetch(ALIAS + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ALIAS, 'x-vercel-protection-bypass': BYPASS, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 200) }; } return { status: r.status, body: j }; };
const sha = execSync('git rev-parse --short HEAD', { cwd: CHECKOUT, encoding: 'utf8' }).trim();
const outDir = `${CHECKOUT}/tests/evidence/visual/${sha}-moves`; mkdirSync(outDir, { recursive: true });
const WIDTHS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }];
const shots = []; const token = () => randomBytes(24).toString('base64url');
const cleanup = []; const notes = [];
async function shoot(page, role, width, name, opts = {}) {
  const file = `${role}-${width.name}-${name}.png`;
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: opts.fullPage !== false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);   // eslint-disable-line no-undef
  shots.push({ file, role, width: width.width, page: name, horizontal_overflow: overflow });
  console.log(`  ${file}${overflow ? '   HORIZONTAL OVERFLOW' : ''}`);
}
const ctxFor = async (browser, W, cookie) => { const ctx = await browser.newContext({ viewport: { width: W.width, height: W.height }, deviceScaleFactor: 1, extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } }); if (cookie) await ctx.addCookies([{ name: cookie[0], value: cookie[1], domain: 'demohub-booker-preview.vercel.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]); return ctx; };
let moveId = null, ownerCookie = null;
try {
  const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import(`file:///${CHECKOUT}/api/booking.js`);
  const b = (await db(`bookings?id=eq.${BOOKING}&select=id,status,payment_status,demo_date,demo_time,brand_id,retailer_id`))[0];
  const demo = (await db(`demos?booking_id=eq.${BOOKING}&select=id,status,demo_date,demo_time,venue_id`))[0];
  if (!b || b.status !== 'confirmed' || b.payment_status !== 'paid' || !demo || demo.status !== 'confirmed') throw new Error('the fixture booking is not a live confirmed paid demo: ' + JSON.stringify({ b, demo }));
  if ((await db(`booking_moves?booking_id=eq.${BOOKING}&status=eq.pending&select=id`)).length) throw new Error('the fixture booking already has a pending move');
  // sessions
  for (const old of await db(`brand_members?brand_id=eq.${BRAND}&email=eq.${encodeURIComponent(BOOKER_EMAIL)}&status=neq.revoked&select=id`)) { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${old.id}`, { method: 'DELETE' }); }
  const m = await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, email: BOOKER_EMAIL, name: 'Visual Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: DEMOHUB_TOS_VERSION, terms_digest: DEMOHUB_TOS_DIGEST }) });
  const memberId = m[0].id;
  cleanup.push(async () => { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${memberId}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by_email: OWNER_EMAIL }) }); });
  const ownerTok = token(), bookerTok = token();
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: ownerTok, email: OWNER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: bookerTok, email: BOOKER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  cleanup.push(() => db(`brand_account_sessions?session_token=eq.${ownerTok}`, { method: 'DELETE' }));
  ownerCookie = 'dh_brand_session=' + ownerTok;
  const storeSid = randomUUID();
  await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: storeSid, email: STORE_ADMIN, retailer_id: RETAILER, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  cleanup.push(() => db(`admin_sessions?session_id=eq.${storeSid}`, { method: 'DELETE' }));
  const storeCookie = 'dh_retailer_session=' + storeSid;

  const browser = await chromium.launch();
  // 1. the store: the Move dialog (move mode, then the ask-first mode) and the calendar detail modal
  for (const W of WIDTHS) {
    const ctx = await ctxFor(browser, W, ['dh_retailer_session', storeSid]); const page = await ctx.newPage();
    await page.goto(`${ALIAS}/r/gus/admin#demos`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    const features = await page.evaluate(() => (window.state && window.state.features) || null);   // eslint-disable-line no-undef
    if (W.name === 'desktop') notes.push({ store_features: features });
    await page.evaluate(([id, name, date, time, venue]) => openRescheduleModal(id, name, date, time, venue), [demo.id, 'Walkthrough Snacks (test)', demo.demo_date, demo.demo_time, demo.venue_id]);   // eslint-disable-line no-undef
    await page.waitForTimeout(800);
    await page.evaluate(() => { const s = document.getElementById('reschedTime'); if (s && s.options.length > 1) { s.selectedIndex = s.selectedIndex === 1 ? 2 : 1; s.dispatchEvent(new Event('change')); } const n = document.getElementById('reschedNote'); if (n) n.value = 'Our morning staffer is out; can you do the later slot?'; });   // eslint-disable-line no-undef
    await page.waitForTimeout(400);
    await shoot(page, 'store', W, 'move-dialog', { fullPage: false });
    await page.evaluate(() => reschedToggleMode()); await page.waitForTimeout(300);   // eslint-disable-line no-undef
    await shoot(page, 'store', W, 'propose-dialog', { fullPage: false });
    await page.evaluate(() => { const w = document.getElementById('reschedModal'); if (w) w.remove(); });   // eslint-disable-line no-undef
    await page.goto(`${ALIAS}/r/gus/admin#calendar`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => { try { const t = document.querySelector('[data-tab="calendar"], .tab[data-view="calendar"]'); if (t) t.click(); } catch (_) {} }); await page.waitForTimeout(1000);   // eslint-disable-line no-undef
    const opened = await page.evaluate((id) => { try { openDemoEventDetail(id); return true; } catch (e) { return String(e.message); } }, demo.id);   // eslint-disable-line no-undef
    await page.waitForTimeout(800);
    if (opened === true) await shoot(page, 'store', W, 'calendar-detail-modal', { fullPage: false }); else notes.push({ calendar_modal: opened });
    await ctx.close();
  }

  // 2. a real pending move through the deployed route (the store moves the demo to another offered slot the same day)
  const newTime = demo.demo_time === '2:00 PM' ? '11:00 AM' : '2:00 PM';
  const mv = await api('/api/booking-action', { action: 'move', demo_id: demo.id, new_date: demo.demo_date, new_time: newTime, note: 'Our morning staffer is out; can you do the later slot?' }, storeCookie);
  if (mv.status !== 200) throw new Error('move refused: ' + JSON.stringify(mv.body));
  moveId = mv.body.move_id; notes.push({ move: mv.body });
  console.log('  pending move created', moveId, '->', newTime);
  for (const W of WIDTHS) {
    for (const [role, tok] of [['owner', ownerTok], ['booker', bookerTok]]) {
      const ctx = await ctxFor(browser, W, ['dh_brand_session', tok]); const page = await ctx.newPage();
      await page.goto(`${ALIAS}/brand/dashboard#overview`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1500);
      await shoot(page, role, W, 'dashboard-overview-pending-move');
      if (role === 'owner') {
        const bannerBox = await page.evaluate(() => { const el = document.querySelector('.move-banner'); if (!el) return null; el.scrollIntoView(); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.innerText.slice(0, 300), buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()) }; });   // eslint-disable-line no-undef
        if (W.name === 'desktop') notes.push({ owner_banner: bannerBox });
        if (bannerBox) { await page.waitForTimeout(300); await shoot(page, role, W, 'dashboard-move-banner', { fullPage: false }); }
      } else {
        const line = await page.evaluate(() => { const t = document.getElementById('mainContent').innerText; const i = t.indexOf('Moved by the store'); return i >= 0 ? t.slice(i, i + 260) : null; });   // eslint-disable-line no-undef
        if (W.name === 'desktop') notes.push({ booker_line: line, booker_buttons: await page.evaluate(() => [...document.querySelectorAll('button')].map(x => x.textContent.trim()).filter(x => /confirm new time|can.t make it/i.test(x))) });   // eslint-disable-line no-undef
      }
      await ctx.close();
    }
  }
  await browser.close();
} catch (e) {
  console.log('visual pass failed:', e.message); notes.push({ error: String(e.message) });
} finally {
  // leave the fixture clean: the owner confirms the pending move through the deployed route; the outbox then skips the notice
  if (moveId && ownerCookie) {
    const rs = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: moveId, decision: 'confirm' }, ownerCookie);
    notes.push({ confirm: { status: rs.status, body: rs.body } });
    const w = await fetch(ALIAS + '/api/notification-worker', { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }).then(r => r.json()).catch(e => ({ error: e.message }));
    notes.push({ notification_worker: { ok: w.ok } });
  }
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify({ sha, alias: ALIAS, taken_at: new Date().toISOString(), booking: BOOKING, move_id: moveId, widths: WIDTHS, shots, notes }, null, 2));
  const overflow = shots.filter(s => s.horizontal_overflow);
  console.log(`\nvisual pass on ${ALIAS} (${sha}): ${shots.length} screenshots in ${outDir}; horizontal overflow on ${overflow.length}: ${overflow.map(s => s.file).join(', ') || 'none'}`);
  console.log(JSON.stringify(notes).slice(0, 1500));
}
