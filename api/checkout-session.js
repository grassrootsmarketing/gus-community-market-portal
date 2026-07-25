// api/checkout-session.js — RETIRED (LG-08). The unbound multi-booking checkout is replaced by
// /api/checkout (session-bound, per-booking ownership guard, Stripe idempotency). This path is closed
// so it cannot be called directly to spawn parallel/unauthorized charges.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  return res.status(410).json({ error: 'endpoint_retired', message: 'Checkout moved to /api/checkout.' });
}
