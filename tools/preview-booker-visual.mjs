// tools/preview-booker-visual.mjs (2026-10-18, Codex shipped-release finding 4): an authenticated visual pass of the
// booker release on the DEPLOYED preview, as the owner and as the booker, at a desktop and a phone width. Screenshots
// land in tests/evidence/visual/<sha>/ with a manifest naming width, role, page and SHA. Test database only; sessions
// are minted directly (no invitation email is sent); the accept page's form state is rendered through a stubbed
// accept-start answer because a real token lives only in the invitation email. Nothing here touches production.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const PW_ROOT = process.env.PLAYWRIGHT_ROOT; const require = createRequire(PW_ROOT + '/package.json'); const { chromium } = require('playwright');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY, BYPASS = String(process.env.VERCEL_BYPASS || '').trim();
if (!SB.includes('tileejdviuvijumjeplv')) { console.error('refusing: SB_URL is not demohub-rebuild-check'); process.exit(2); }
const ALIAS = 'https://demohub-booker-preview.vercel.app';
const BRAND = 'ddf24429-e22d-4c34-8fef-1a6004b7ae9c', OWNER_EMAIL = 'david+walkthrough@demohubhq.com', RETAILER = 'f4f1da68-b23c-481c-b735-e119ed975aa7', STORE_ADMIN = 'david@demohubhq.com';
const BOOKER_EMAIL = 'david+visual@demohubhq.com';
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error('db ' + path.slice(0, 60) + ' ' + r.status + ' ' + t.slice(0, 160)); return j; };
const sha = execSync('git rev-parse --short HEAD', { cwd: 'C:/Users/David/demohub-preview', encoding: 'utf8' }).trim();
const outDir = `C:/Users/David/demohub/tests/evidence/visual/${sha}`; mkdirSync(outDir, { recursive: true });
const WIDTHS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }];
const shots = []; const token = () => randomBytes(24).toString('base64url');
const cleanup = [];
async function shoot(page, role, width, name, opts = {}) {
  const file = `${role}-${width.name}-${name}.png`;
  await page.screenshot({ path: `${outDir}/${file}`, fullPage: opts.fullPage !== false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);   // eslint-disable-line no-undef
  shots.push({ file, role, width: width.width, page: name, horizontal_overflow: overflow });
  console.log(`  ${file}${overflow ? '   HORIZONTAL OVERFLOW' : ''}`);
}
try {
  const { DEMOHUB_TOS_VERSION, DEMOHUB_TOS_DIGEST } = await import('file:///C:/Users/David/demohub-preview/api/booking.js');
  for (const old of await db(`brand_members?brand_id=eq.${BRAND}&email=eq.${encodeURIComponent(BOOKER_EMAIL)}&status=neq.revoked&select=id`)) { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${old.id}`, { method: 'DELETE' }); }
  const m = await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, email: BOOKER_EMAIL, name: 'Visual Booker', role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: DEMOHUB_TOS_VERSION, terms_digest: DEMOHUB_TOS_DIGEST }) });
  const memberId = m[0].id;
  cleanup.push(async () => { await db(`brand_account_sessions?email=eq.${encodeURIComponent(BOOKER_EMAIL)}`, { method: 'DELETE' }); await db(`brand_members?id=eq.${memberId}`, { method: 'PATCH', body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by_email: OWNER_EMAIL }) }); });
  const ownerTok = token(), bookerTok = token();
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: ownerTok, email: OWNER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: BRAND, session_token: bookerTok, email: BOOKER_EMAIL, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  cleanup.push(() => db(`brand_account_sessions?session_token=eq.${ownerTok}`, { method: 'DELETE' }));
  const storeSid = (await import('node:crypto')).randomUUID();
  await db('admin_sessions', { method: 'POST', body: JSON.stringify({ session_id: storeSid, email: STORE_ADMIN, retailer_id: RETAILER, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
  cleanup.push(() => db(`admin_sessions?session_id=eq.${storeSid}`, { method: 'DELETE' }));

  const browser = await chromium.launch();
  for (const W of WIDTHS) {
    for (const [role, cookieName, tok] of [['owner', 'dh_brand_session', ownerTok], ['booker', 'dh_brand_session', bookerTok]]) {
      const ctx = await browser.newContext({ viewport: { width: W.width, height: W.height }, deviceScaleFactor: 1, extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } });
      await ctx.addCookies([{ name: cookieName, value: tok, domain: 'demohub-booker-preview.vercel.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      const tabs = role === 'owner' ? ['overview', 'retailers', 'agreements', 'account'] : ['overview', 'retailers', 'calendar', 'account'];
      for (const tab of tabs) {
        await page.goto(`${ALIAS}/brand/dashboard#${tab}`, { waitUntil: 'networkidle' }).catch(() => {});
        await page.evaluate((t) => { try { switchTab(t); } catch (_) {} }, tab); await page.waitForTimeout(1200);   // eslint-disable-line no-undef
        await shoot(page, role, W, `dashboard-${tab}`);
      }
      if (role === 'owner') {
        // the signature modal from the Retailers tab (the store's current text; closed without signing)
        await page.goto(`${ALIAS}/brand/dashboard#retailers`, { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(1200);
        await page.evaluate(() => openStoreAgreement('gus', "Gus's Community Market (TEST)")); await page.waitForTimeout(1500);   // eslint-disable-line no-undef
        if (await page.locator('#dhAgreementOverlay').count()) await shoot(page, role, W, 'dashboard-agreement-modal', { fullPage: false });
        else console.log('  (owner agreement modal not opened: agreement already current, as expected)');
      }
      // booking page: the confirm form (booker: locked identity fields and the policies link) and the read-only policies
      await page.goto(`${ALIAS}/r/gus`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(2000);
      await shoot(page, role, W, 'booking-page');
      await page.evaluate(() => { cart = [{ id: 'v1', dateStr: '2027-01-05', displayDate: 'Jan 5', time: '10:00 AM', location: 'Gus Main Street (TEST)', price: 30 }]; confirmBooking(); }).catch(() => {});   // eslint-disable-line no-undef
      await page.waitForTimeout(800);
      await shoot(page, role, W, 'booking-confirm-form', { fullPage: false });
      if (role === 'booker') {
        await page.evaluate(() => openStorePoliciesReadOnly()).catch(() => {}); await page.waitForTimeout(1200);   // eslint-disable-line no-undef
        await shoot(page, role, W, 'booking-policies-readonly', { fullPage: false });
      }
      await ctx.close();
    }
    // the accept page: invalid state (real), and the form state (accept-start stubbed, since a real token lives only in the email)
    {
      const ctx = await browser.newContext({ viewport: { width: W.width, height: W.height }, extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } });
      const page = await ctx.newPage();
      await page.goto(`${ALIAS}/brand/accept?t=visual-pass-not-a-real-token-000000`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(800); await shoot(page, 'invitee', W, 'accept-invalid');
      await page.route('**/api/brand-account', async (route) => { let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {} if (body.action === 'booker-accept-start') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, brand_name: 'Walkthrough Snacks (test)', email_hint: 'd*****@demohubhq.com', booker_name: 'Visual Booker', permissions: "A booker can book demos for this brand, pick from its saved items, and see its demos. A booker cannot add or change items, see payments or receipts, change the profile or insurance certificate, or agree to a store's policies.", terms_version: DEMOHUB_TOS_VERSION, terms_url: '/terms' }) }); return route.continue(); });
      await page.goto(`${ALIAS}/brand/accept?t=visual-pass-stubbed-token-00000000`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(800); await page.fill('#code', '123456').catch(() => {}); await page.check('#terms').catch(() => {});
      await shoot(page, 'invitee', W, 'accept-form');
      await ctx.close();
    }
    // the store admin: calendar with the detail modal and its actions
    {
      const ctx = await browser.newContext({ viewport: { width: W.width, height: W.height }, extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } });
      await ctx.addCookies([{ name: 'dh_retailer_session', value: storeSid, domain: 'demohub-booker-preview.vercel.app', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      await page.goto(`${ALIAS}/r/gus/admin#calendar`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.evaluate(() => { try { const t = document.querySelector('[data-tab="calendar"], .tab[data-view="calendar"]'); if (t) t.click(); } catch (_) {} }); await page.waitForTimeout(1200);   // eslint-disable-line no-undef
      await shoot(page, 'store', W, 'admin-calendar');
      const opened = await page.evaluate(() => { const d = (window.state && window.state.demos || []).find(x => String(x.status || '').toLowerCase() === 'confirmed' && x.booking_id); if (!d) return false; openDemoEventDetail(d.id); return true; });   // eslint-disable-line no-undef
      await page.waitForTimeout(800);
      if (opened) await shoot(page, 'store', W, 'admin-calendar-modal', { fullPage: false }); else console.log('  (no confirmed demo to open on the store calendar)');
      await ctx.close();
    }
  }
  await browser.close();
} finally {
  for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { console.log('cleanup failed:', e.message); } }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify({ sha, alias: ALIAS, taken_at: new Date().toISOString(), widths: WIDTHS, shots }, null, 2));
  const overflow = shots.filter(s => s.horizontal_overflow);
  console.log(`\nvisual pass on ${ALIAS} (${sha}): ${shots.length} screenshots in ${outDir}; horizontal overflow on ${overflow.length}: ${overflow.map(s => s.file).join(', ') || 'none'}`);
}
