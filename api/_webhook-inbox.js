// api/_webhook-inbox.js — F5-17 / LG-05: a Stripe event is only marked 'completed' after its
// handler fully succeeds. If a DB write fails mid-handler we mark it 'failed' and return a
// retryable error, so Stripe retries and the event is reclaimed — never silently lost.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}
// claim: returns 'process' (go handle it) or 'skip' (already completed)
export async function claimEvent(eventId, type) {
  const ins = await rest('processed_stripe_events', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ event_id: eventId, event_type: type, status: 'processing' }) });
  if (ins.ok) return 'process';
  if (ins.status === 409) {
    const q = await rest(`processed_stripe_events?event_id=eq.${encodeURIComponent(eventId)}&select=status`);
    const st = q.ok ? (await q.json())[0]?.status : null;
    return st === 'completed' ? 'skip' : 'process';  // failed/processing -> reclaim
  }
  return 'process';
}
export async function markCompleted(eventId) {
  await rest(`processed_stripe_events?event_id=eq.${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed', processed_at: new Date().toISOString() }) });
}
export async function markFailed(eventId, err) {
  await rest(`processed_stripe_events?event_id=eq.${encodeURIComponent(eventId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', last_error: String(err).slice(0, 300) }) });
}
