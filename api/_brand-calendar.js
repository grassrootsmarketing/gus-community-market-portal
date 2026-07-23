// api/_brand-calendar.js — F5-22 / LG-04: calendar feed uses a dedicated revocable token, not
// the brand session. Resolving a feed by this token grants ONLY calendar read; it is never a session.
import crypto from 'node:crypto';
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const rest=(p,o={})=>fetch(`${SUPABASE_URL}/rest/v1/${p}`,{...o,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',...(o.headers||{})}});

// issue (or rotate) the calendar token. Rotating REVOKES old calendar URLs.
export async function issueCalToken(brandId) {
  const token = crypto.randomBytes(24).toString('hex');
  await rest(`brands?id=eq.${encodeURIComponent(brandId)}`, { method:'PATCH', body: JSON.stringify({ cal_feed_token: token }) });
  return token;
}
// resolve a feed request BY CAL TOKEN ONLY. A session token will NOT match.
export async function resolveCalToken(token) {
  if (!token) return null;
  const r = await rest(`brands?cal_feed_token=eq.${encodeURIComponent(token)}&select=id,company_name&limit=1`);
  const b = r.ok ? (await r.json())[0] : null;
  return b ? { brandId: b.id } : null;
}
