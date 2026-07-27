// api/refund-worker.js — refund retry + reconciliation worker (Codex R9-D #7/#8).
//
// Closes the gap where a refund reserved money in the ledger but Stripe never confirmed a
// terminal outcome. Runs on a schedule (Vercel Cron) behind CRON_SECRET. It NEVER moves money
// on its own reasoning: every Stripe write reuses the refund request's stored idempotency key,
// so a resubmit can only ever return the ORIGINAL refund (no double refund) — and past Stripe's
// 24h idempotency window, it refuses to blind-resubmit and instead reconciles by lookup.
//
// Phases, per refund_requests row that is not yet terminal:
//   A. Has a stripe_refund_id  -> GET the refund, converge via finalize_refund (recovers a lost
//      or delayed charge.refunded / refund.* webhook).
//   B. No stripe_refund_id, age <= 24h -> resubmit with the SAME idempotency key (safe replay).
//   C. No stripe_refund_id, age  > 24h -> the key has expired; LIST the PI's refunds and adopt
//      the one tagged with this request id. If none exists, park as requires_review (manual) —
//      we do NOT create a new refund, because that could double-refund.
// Attempts are capped so a genuinely broken row lands in requires_review instead of spinning.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_ATTEMPTS = 6;                 // after this, stop auto-retrying; leave for a human
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000; // Stripe idempotency keys live ~24h
const BATCH = 50;

// ---- Supabase REST (service role; RLS-on tables are service-role only) ----
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}

// ---- Stripe ----
async function stripeGetRefund(id) {
  const r = await fetch(`https://api.stripe.com/v1/refunds/${encodeURIComponent(id)}`, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
  return { ok: true, refund: j };
}
async function stripeListRefundsForPI(pi) {
  const r = await fetch(`https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
  return { ok: true, data: Array.isArray(j.data) ? j.data : [] };
}
async function stripeSubmitRefund({ pi, amountCents, currency, keepsAll, idempotencyKey, requestId, bookingId }) {
  const params = new URLSearchParams();
  params.set('payment_intent', pi);
  if (Number.isFinite(amountCents) && amountCents > 0) params.set('amount', String(Math.round(amountCents)));
  if (currency) params.set('currency', String(currency));
  if (!keepsAll) { params.set('refund_application_fee', 'true'); params.set('reverse_transfer', 'true'); }
  params.set('reason', 'requested_by_customer');
  params.set('metadata[refund_request_id]', String(requestId));
  if (bookingId) params.set('metadata[booking_id]', String(bookingId));
  const headers = { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);
  const r = await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers, body: params.toString() });
  const j = await r.json();
  if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status), detail: j };
  return { ok: true, refund: j };
}

async function bumpAttempt(row, patch) {
  try {
    await sb(`refund_requests?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ attempts: (row.attempts || 0) + 1, ...patch }),
    });
  } catch (_) {}
}

// Attach a stripe_refund_id to the request, then converge the ledger from the refund's status.
async function adoptAndFinalize(row, refund) {
  // record the id if we didn't have it (unique column; ignore a duplicate-key race)
  if (!row.stripe_refund_id) {
    try { await sb(`refund_requests?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify({ stripe_refund_id: refund.id, status: 'submitted' }) }); } catch (_) {}
  }
  // finalize_refund is idempotent (terminal rows return 'already_terminal'); pass Stripe's own status through
  const res = await sbRpc('finalize_refund', { p_stripe_refund_id: refund.id, p_status: refund.status || 'pending', p_amount: refund.amount, p_currency: refund.currency });
  const val = Array.isArray(res) ? res[0] : res;
  return val;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  // Cron auth: Vercel Cron sends Authorization: Bearer <CRON_SECRET>. No secret set => disabled (fail closed).
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_SECRET_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const out = { ok: true, scanned: 0, reconciled: 0, resubmitted: 0, adopted: 0, manual: 0, capped: 0, errors: 0 };
  try {
    // Non-terminal refund requests, oldest first. Embed the PI + keeps-all flag via the FK chain.
    const rows = await sb(
      `refund_requests?status=in.(reserved,requires_review,submitted,pending)&attempts=lt.${MAX_ATTEMPTS}` +
      `&select=id,booking_id,amount,currency,status,stripe_idempotency_key,stripe_refund_id,attempts,created_at,` +
      `payment_allocations!inner(payment_groups!inner(stripe_payment_intent_id,platform_keeps_all))` +
      `&order=created_at.asc&limit=${BATCH}`
    );
    out.scanned = Array.isArray(rows) ? rows.length : 0;

    for (const row of (rows || [])) {
      try {
        const alloc = row.payment_allocations || {};
        const grp = alloc.payment_groups || {};
        const pi = grp.stripe_payment_intent_id;
        const keepsAll = !!grp.platform_keeps_all;
        const ageMs = Date.now() - new Date(row.created_at).getTime();

        // ---- Phase A: we have a refund id -> reconcile from Stripe (recovers lost webhooks) ----
        if (row.stripe_refund_id) {
          const g = await stripeGetRefund(row.stripe_refund_id);
          if (!g.ok) { out.errors++; await bumpAttempt(row, { last_error: ('get: ' + g.error).slice(0, 200) }); continue; }
          await adoptAndFinalize(row, g.refund);
          out.reconciled++;
          continue;
        }

        // No refund id and no PI on the group -> nothing Stripe-side could exist. Park for review.
        if (!pi) {
          await bumpAttempt(row, { status: 'requires_review', last_error: 'no_payment_intent_on_group' });
          out.manual++;
          continue;
        }

        // ---- Phase B: within idempotency window -> safe replay with the stored key ----
        if (ageMs <= IDEMPOTENCY_WINDOW_MS) {
          const s = await stripeSubmitRefund({
            pi, amountCents: row.amount, currency: row.currency, keepsAll,
            idempotencyKey: row.stripe_idempotency_key, requestId: row.id, bookingId: row.booking_id,
          });
          if (s.ok) {
            await adoptAndFinalize(row, s.refund); // records id + converges
            await bumpAttempt(row, {});
            out.resubmitted++;
          } else {
            const willCap = (row.attempts || 0) + 1 >= MAX_ATTEMPTS;
            await bumpAttempt(row, { status: willCap ? 'requires_review' : row.status, last_error: ('submit: ' + s.error).slice(0, 200) });
            if (willCap) out.capped++; else out.errors++;
          }
          continue;
        }

        // ---- Phase C: window expired, no id -> reconcile by lookup; never blind-resubmit ----
        const list = await stripeListRefundsForPI(pi);
        if (!list.ok) { out.errors++; await bumpAttempt(row, { last_error: ('list: ' + list.error).slice(0, 200) }); continue; }
        const match = list.data.find(rf => rf.metadata && String(rf.metadata.refund_request_id) === String(row.id));
        if (match) {
          await adoptAndFinalize(row, match);
          out.adopted++;
        } else {
          // No refund was ever created for this reservation and the safe-replay window is gone.
          await bumpAttempt(row, { status: 'requires_review', last_error: 'idempotency_window_expired_no_refund_found' });
          out.manual++;
        }
      } catch (e) {
        out.errors++;
        try { await bumpAttempt(row, { last_error: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
      }
    }

    return res.status(200).json(out);
  } catch (e) {
    console.error('refund-worker error:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'worker_error' });
  }
}
