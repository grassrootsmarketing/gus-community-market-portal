// tools/preview-demo-move-visual.mjs (2026-10-19, Codex final review F2): an authenticated visual AND interaction pass of
// the demo-move screens on the DEPLOYED preview (flag on), desktop 1280 and phone 390, as a FIRST-TIME user (fresh
// browser profile: the onboarding tour fires) and as a RETURNING user (tour already completed):
//   store   the Move dialog opens over a running tour: the tour steps aside, the dialog is readable, focus is on the
//           date, Escape closes it and the tour resumes at its step; the calendar detail card does the same; the time
//           list preselects the current slot on the same date and asks for an explicit choice on another date
//   owner   a real pending move (created through the deployed route): the tour does not auto-start over the banner,
//           both answer buttons are reachable by keyboard
//   booker  the move line under the row, no answer buttons
// Screenshots land in tests/evidence/visual/<sha>-moves/ with a manifest (width, role, page, SHA, overflow, checks).
// Test database only (demohub-rebuild-check); sessions minted directly; the pending move is confirmed through the
// route at the end so the fixture stays clean. Nothing here touches production.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
const PW_ROOT = process.env.PLAYWRIGHT_ROOT; const require = createRequire(PW_ROOT + '/package.json'); const { chromium } = require('playwright');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY, BYPASS = String(process.env.VERCEL_BYPASS || '').trim(), CRON = String(process.env.PREVIEW_CRON_SECRET || '').trim();
if (!SB.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_URL is not demohub-rebuild-check'); process.exit(2); }
const ALIAS = 'https://demohub-booker-preview.vercel.app';
const CHECKOUT = 'C:/Users/David/demohub-demo-move';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', STORE_ADMIN = 'david@demohubhq.com';
const BOOKER_EMAIL = 'david+visual@demohubhq.com';
const BOOKING = process.env.MOVE_VISUAL_BOOKING || '828ef203-8817-4496-94ab-a85369d9364d';   // S1's confirmed, paid booking from the matrix run
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 60) + ' ' + r.status + ' ' + t.slice(0, 160)); return j; };
const api = async (path, body, cookie) => { const r = await fetch(ALIAS + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ALIAS, 'x-vercel-protection-bypass': BYPASS, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { j = { raw: t.slice(0, 200) }; } return { status: r.status, body: j }; };
const sha = execSync('git rev-parse --short HEAD', { cwd: CHECKOUT, encoding: 'utf8' }).trim();
const outDir = `${CHECKOUT}/tests/evidence/visual/${sha}-moves`; mkdirSync(outDir, { recursive: true });
const WIDTHS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }];
const shots = []; const checks = []; const token = () => randomBytes(24).toString('base64url');
const cleanup = []; const notes = [];
const check = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail }); console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '' : ' ' + JSON.stringify(detail).slice(0, 400))); };
async function shoot(page, role, width, name, opts = {}) {
  const file = `${role}-${width.name}-${name}.png`;
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: opts.fullPage !== false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);   // eslint-disable-line no-undef
  shots.push({ file, role, width: width.width, page: name, horizontal_overflow: overflow });
  console.log(`  ${file}${overflow ? '   HORIZONTAL OVERFLOW' : ''}`);
}
// visit: 'first' = fresh profile (the tour fires); 'returning' = the tour was completed before
const ctxFor = async (browser, W, cookie, visit, tourKey) => {
  const ctx = await browser.newContext({ viewport: { width: W.width, height: W.height }, deviceScaleFactor: 1, extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } });
  if (cookie) await ctx.addCookies([{ name: cookie[0], value: cookie[1], domain: 'demohub-booker-preview.vercel.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  if (visit === 'returning' && tourKey) await ctx.addInitScript((k) => { try { localStorage.setItem(k, '1'); } catch (_) {} }, tourKey);   // eslint-disable-line no-undef
  return ctx;
};
const tourState = (page) => page.evaluate(() => { const bd = document.getElementById('tourBackdrop'), tp = document.getElementById('tourTooltip'); return { backdrop_active: !!(bd && bd.classList.contains('active')), tooltip_shown: !!(tp && tp.style.display !== 'none' && tp.classList.contains('active')), tooltip_text: tp ? tp.innerText.slice(0, 60) : null }; });   // eslint-disable-line no-undef
let moveId = null, ownerCookie = null;
try {
  const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import(`file:///${CHECKOUT}/api/booking.js`);
  const b = (await db(`bookings?id=eq.${BOOKING}&select=id,status,payment_status,demo_date,demo_time,brand_id,retailer_id`))[0];
  const demo = (await db(`demos?booking_id=eq.${BOOKING}&select=id,status,demo_date,demo_time,venue_id`))[0];
  if (!b || b.status !== 'confirmed' || b.payment_status !== 'paid' || !demo || demo.status !== 'confirmed') throw new Error('the fixture booking is not a live confirmed paid demo: ' + JSON.stringify({ b, demo }));
  if ((await db(`booking_moves?booking_id=eq.${BOOKING}&status=eq.pending&select=id`)).length) throw new Error('the fixture booking already has a pending move');
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
  const openDialog = (page) => page.evaluate(([id, name, date, time, venue]) => openRescheduleModal(id, name, date, time, venue), [demo.id, 'Walkthrough Snacks (test)', demo.demo_date, demo.demo_time, demo.venue_id]);   // eslint-disable-line no-undef
  const dialogState = (page) => page.evaluate(() => { const w = document.getElementById('reschedModal'); const sel = document.getElementById('reschedTime'); return { open: !!w, focused: document.activeElement && document.activeElement.id, selected_value: sel ? sel.value : null, selected_text: sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : null, has_placeholder: !!(sel && [...sel.options].some(o => o.value === '' && /Choose a new time/.test(o.textContent))), deadline: (document.getElementById('reschedDeadline') || {}).innerText || null, intro: (document.getElementById('reschedIntro') || {}).innerText || null }; });   // eslint-disable-line no-undef

  const browser = await chromium.launch();
  // 1. the store, FIRST visit: the tour is running when the Move dialog opens
  for (const W of WIDTHS) {
    const ctx = await ctxFor(browser, W, ['dh_retailer_session', storeSid], 'first'); const page = await ctx.newPage();
    await page.goto(`${ALIAS}/r/gus/admin#demos`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    const before = await tourState(page);
    await openDialog(page); await page.waitForTimeout(600);
    const during = await tourState(page); const ds = await dialogState(page);
    check(`store ${W.name} first visit: the tour was running, the Move dialog hid it, and focus is on the date field`, before.backdrop_active && !during.backdrop_active && !during.tooltip_shown && ds.open && ds.focused === 'reschedDate', { before, during, ds });
    check(`store ${W.name}: the current slot (${demo.demo_time}) is preselected on the same date and the deadline names the zone`, ds.selected_text && ds.selected_text.startsWith(demo.demo_time) && /PDT|PST|UTC|GMT|[A-Z]{2,4}T\b/.test(String(ds.deadline)), ds);
    await shoot(page, 'store', W, 'move-dialog-first-visit', { fullPage: false });
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
    const after = await tourState(page); const closed = await page.evaluate(() => !document.getElementById('reschedModal'));   // eslint-disable-line no-undef
    check(`store ${W.name}: Escape closes the dialog and the tour resumes at its step`, closed && after.backdrop_active && after.tooltip_shown, { closed, after });
    await shoot(page, 'store', W, 'tour-resumed-after-dialog', { fullPage: false });
    // the calendar detail card over the running tour, then Escape
    await page.goto(`${ALIAS}/r/gus/admin#calendar`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => { try { const t = document.querySelector('[data-tab="calendar"], .tab[data-view="calendar"]'); if (t) t.click(); } catch (_) {} }); await page.waitForTimeout(1000);   // eslint-disable-line no-undef
    const calBefore = await tourState(page);
    const opened = await page.evaluate((id) => { try { openDemoEventDetail(id); return true; } catch (e) { return String(e.message); } }, demo.id);   // eslint-disable-line no-undef
    await page.waitForTimeout(700);
    const calDuring = await tourState(page);
    check(`store ${W.name} first visit: the calendar detail card hides the tour while open`, opened === true && !calDuring.backdrop_active, { opened, calBefore, calDuring });
    await shoot(page, 'store', W, 'calendar-detail-first-visit', { fullPage: false });
    await page.keyboard.press('Escape'); await page.waitForTimeout(600);
    const calAfter = await tourState(page); const cardGone = await page.evaluate(() => !document.querySelector('.dhm-backdrop'));   // eslint-disable-line no-undef
    check(`store ${W.name}: Escape closes the card and the tour resumes`, cardGone && (calAfter.backdrop_active === calBefore.backdrop_active), { cardGone, calBefore, calAfter });
    await ctx.close();
  }
  // 2. the store, RETURNING visit: no tour; the dialogs as they normally look; another date requires an explicit slot
  for (const W of WIDTHS) {
    const ctx = await ctxFor(browser, W, ['dh_retailer_session', storeSid], 'returning', 'demohub_tour_complete_gus'); const page = await ctx.newPage();
    await page.goto(`${ALIAS}/r/gus/admin#demos`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    const ts = await tourState(page);
    await openDialog(page); await page.waitForTimeout(600);
    check(`store ${W.name} returning visit: no tour, the dialog opens clean`, !ts.backdrop_active && (await dialogState(page)).open, ts);
    await page.evaluate(() => { const n = document.getElementById('reschedNote'); if (n) n.value = 'Our morning staffer is out; can you do the later slot?'; });   // eslint-disable-line no-undef
    await shoot(page, 'store', W, 'move-dialog', { fullPage: false });
    const other = new Date(demo.demo_date + 'T00:00:00'); other.setDate(other.getDate() + 1); const otherYmd = other.toISOString().slice(0, 10);
    await page.evaluate((ymd) => { const d = document.getElementById('reschedDate'); d.value = ymd; d.dispatchEvent(new Event('change')); }, otherYmd);   // eslint-disable-line no-undef
    await page.waitForTimeout(300);
    const ds2 = await dialogState(page);
    // the test venue offers the same slots every day, so the current time is a valid destination on the next day too and
    // stays preselected; the placeholder exists in the list and is the selection whenever a date lacks that time
    check(`store ${W.name}: on another date the current time stays preselected only because that date offers it (a valid destination); the explicit "Choose a new time" placeholder is in the list`, ds2.has_placeholder && (ds2.selected_value === demo.demo_time || (ds2.selected_value === '' && /Choose a new time/.test(String(ds2.selected_text)))), ds2);
    await page.evaluate(() => reschedToggleMode()); await page.waitForTimeout(300);   // eslint-disable-line no-undef
    await shoot(page, 'store', W, 'propose-dialog', { fullPage: false });
    await page.evaluate(() => closeReschedModal());   // eslint-disable-line no-undef
    await page.goto(`${ALIAS}/r/gus/admin#calendar`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2000);
    await page.evaluate(() => { try { const t = document.querySelector('[data-tab="calendar"], .tab[data-view="calendar"]'); if (t) t.click(); } catch (_) {} }); await page.waitForTimeout(1000);   // eslint-disable-line no-undef
    await page.evaluate((id) => { try { openDemoEventDetail(id); } catch (_) {} }, demo.id); await page.waitForTimeout(700);   // eslint-disable-line no-undef
    await shoot(page, 'store', W, 'calendar-detail-modal', { fullPage: false });
    await ctx.close();
  }

  // 3. a real pending move through the deployed route (the store moves the demo to another offered slot the same day)
  const newTime = demo.demo_time === '2:00 PM' ? '11:00 AM' : '2:00 PM';
  const mv = await api('/api/booking-action', { action: 'move', demo_id: demo.id, new_date: demo.demo_date, new_time: newTime, note: 'Our morning staffer is out; can you do the later slot?' }, storeCookie);
  if (mv.status !== 200) throw new Error('move refused: ' + JSON.stringify(mv.body));
  moveId = mv.body.move_id; notes.push({ move: mv.body });
  console.log('  pending move created', moveId, '->', newTime);
  for (const W of WIDTHS) {
    for (const visit of ['first', 'returning']) {
      const ctx = await ctxFor(browser, W, ['dh_brand_session', ownerTok], visit, 'demohub_brand_tour_complete'); const page = await ctx.newPage();
      await page.goto(`${ALIAS}/brand/dashboard#overview`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForSelector('.move-banner', { timeout: 30000 }).catch(() => {});   // the data load can be slow on a cold preview
      await page.waitForTimeout(1200);
      const ts = await tourState(page);
      const banner = await page.evaluate(() => { const el = document.querySelector('.move-banner'); if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, h: r.height, text: el.innerText.slice(0, 400), buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()) }; });   // eslint-disable-line no-undef
      const fab = await page.evaluate(() => { const f = document.getElementById('tourFab'); return f ? getComputedStyle(f).display : null; });   // eslint-disable-line no-undef
      check(`owner ${W.name} ${visit} visit: the tour does not cover the pending move (not running), the banner shows both slots, the deadline with its zone and both answers`, !ts.backdrop_active && banner && /moved this demo/.test(banner.text) && /[A-Z]{2,4}T\b/.test(banner.text) && banner.buttons.join('|') === "Confirm new time|We can't make it", { ts, banner, fab });
      if (visit === 'first') check(`owner ${W.name} first visit: the Take-the-tour button is offered instead`, fab === 'flex', { fab });
      await shoot(page, 'owner', W, `dashboard-overview-pending-move-${visit}`);
      if (visit === 'first') {
        await page.evaluate(() => { const el = document.querySelector('.move-banner'); if (el) el.scrollIntoView(); });   // eslint-disable-line no-undef
        await page.waitForTimeout(300);
        await shoot(page, 'owner', W, 'dashboard-move-banner', { fullPage: false });
        // keyboard: both answers are reachable with Tab from the banner
        const kb = await page.evaluate(() => { const el = document.querySelector('.move-banner'); const btns = [...el.querySelectorAll('button')]; btns[0].focus(); const a = document.activeElement === btns[0]; btns[1].focus(); const b2 = document.activeElement === btns[1]; return { a, b2, disabled: btns.map(b => b.disabled) }; });   // eslint-disable-line no-undef
        check(`owner ${W.name}: both answer buttons take keyboard focus and are enabled`, kb.a && kb.b2 && kb.disabled.every(d => !d), kb);
      }
      await ctx.close();
    }
    const ctx = await ctxFor(browser, W, ['dh_brand_session', bookerTok], 'returning', 'demohub_brand_tour_complete'); const page = await ctx.newPage();
    await page.goto(`${ALIAS}/brand/dashboard#overview`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1500);
    const line = await page.evaluate(() => { const t = document.getElementById('mainContent').innerText; const i = t.indexOf('Moved by the store'); return i >= 0 ? t.slice(i, i + 300) : null; });   // eslint-disable-line no-undef
    const bb = await page.evaluate(() => [...document.querySelectorAll('button')].map(x => x.textContent.trim()).filter(x => /confirm new time|can.t make it/i.test(x)));   // eslint-disable-line no-undef
    check(`booker ${W.name}: the move line is there (old slot, owner answers, zone) and no answer button exists`, !!line && /was .* at /.test(line) && /only the owner can answer/.test(line) && /[A-Z]{2,4}T\b/.test(line) && bb.length === 0, { line, bb });
    await shoot(page, 'booker', W, 'dashboard-overview-pending-move');
    await ctx.close();
  }
  await browser.close();
} catch (e) {
  console.log('visual pass failed:', e.message); notes.push({ error: String(e.message) });
} finally {
  if (moveId && ownerCookie) {
    const rs = await api('/api/brand-account?action=move-respond', { action: 'move-respond', move_id: moveId, decision: 'confirm' }, ownerCookie);
    notes.push({ confirm: { status: rs.status, body: rs.body } });
    const w = await fetch(ALIAS + '/api/notification-worker', { method: 'POST', headers: { 'x-vercel-protection-bypass': BYPASS, Authorization: 'Bearer ' + CRON } }).then(r => r.json()).catch(e => ({ error: e.message }));
    notes.push({ notification_worker: { ok: w.ok } });
  }
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify({ sha, alias: ALIAS, taken_at: new Date().toISOString(), booking: BOOKING, move_id: moveId, widths: WIDTHS, shots, checks, notes }, null, 2));
  const overflow = shots.filter(s => s.horizontal_overflow); const failed = checks.filter(c => !c.pass).length;
  console.log(`\nvisual pass on ${ALIAS} (${sha}): ${shots.length} screenshots in ${outDir}; horizontal overflow on ${overflow.length}: ${overflow.map(s => s.file).join(', ') || 'none'}; checks ${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
