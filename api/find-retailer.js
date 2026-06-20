// /api/find-retailer — Lightweight existence check for a retailer slug.
// Used by the /signin page so we can give a useful error before redirecting.
// Returns { ok: true, name } on hit, 404 on miss.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_KEY = 'sb_publishable__e8tiRc5-f7Wexa-r1Perg_hJ84vltF';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const slug = String(req.query?.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/retailers?slug=eq.${encodeURIComponent(slug)}&select=name`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ ok: true, name: arr[0].name });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
