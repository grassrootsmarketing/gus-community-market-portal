// api/_mail.js — the ONLY way this application sends email.
//
// Codex finding C: api/_env.js already parsed EMAIL_ALLOWLIST and returned emailMode /
// emailAllowlist / siteOrigin — and nothing consumed any of them. 24 call sites across 11 files
// called api.resend.com directly with a key read straight from process.env, and built links from
// a hardcoded production host.
//
// That combination is how a staging test emails a real customer a link into production. The
// containment existed on paper only, which is the same failure shape as the binding guard that
// nothing called.
//
// RULES ENFORCED HERE, NOT BY CONVENTION:
//   * every recipient is checked against the bound emailMode before any network call
//   * in a non-production target, a non-allowlisted address CANNOT receive mail — the message is
//     rewritten to the sink and the intended recipient is recorded in the subject and body
//   * production requires the explicit real-email gate (enforced in _env.js) AND a provider key
//   * a missing provider key throws. It never logs the code, link or token it was carrying —
//     "no key, so print the magic link to the console" is a credential leak into log storage
//   * links are built from the bound origin via link(), never from a hardcoded host
//   * opts.idempotencyKey is forwarded as Resend's Idempotency-Key header (documented dedupe window:
//     24 hours) so the notification outbox can retry a send without a duplicate email; the caller
//     freezes the exact payload it first sent under that key and never reuses the key for another
//   * opts.timeoutMs bounds the provider call; a timeout or network failure is reported as
//     mail_provider_unreachable — the request MAY have reached the provider, which is a different
//     outcome from a definite rejection (mail_send_failed) and callers must treat it as unknown

import { getBinding, link, BindingError } from './_env.js';

export class MailError extends Error {
  constructor(code, detail) { super(code); this.name = 'MailError'; this.code = code; this.detail = detail || null; }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function normalise(addr) { return String(addr || '').trim().toLowerCase(); }

function asList(to) {
  if (Array.isArray(to)) return to.map(normalise).filter(Boolean);
  return [normalise(to)].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Containment decision. Pure — testable without a network.
// ---------------------------------------------------------------------------
export function planDelivery(binding, recipients) {
  const list = asList(recipients);
  if (!list.length) throw new MailError('no_recipient');

  if (binding.emailMode === 'real') {
    return { mode: 'real', to: list, redirected: false, intended: list };
  }

  // Non-production. Anything not explicitly allowlisted is redirected, never delivered.
  const allow = new Set((binding.emailAllowlist || []).map(normalise));
  if (!allow.size) throw new MailError('email_allowlist_empty');

  const permitted = list.filter(a => allow.has(a));
  if (permitted.length === list.length) {
    return { mode: 'sink', to: list, redirected: false, intended: list };
  }

  // The sink is the first allowlist entry — an address the operator explicitly nominated.
  const sink = [...allow][0];
  return { mode: 'sink', to: [sink], redirected: true, intended: list };
}

// ---------------------------------------------------------------------------
// Send. The only function in the codebase permitted to reach the mail provider.
// ---------------------------------------------------------------------------
export async function sendMail({ to, subject, html, text, replyTo, from }, opts = {}) {
  const binding = opts.binding || await getBinding();
  const fetchImpl = opts.fetch || globalThis.fetch;
  const idempotencyKey = opts.idempotencyKey ? String(opts.idempotencyKey).slice(0, 256) : null;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : null;

  const plan = planDelivery(binding, to);

  if (!binding.resendApiKey) {
    // Deliberately no recipient, subject, body, code or link in this error or any log line.
    throw new MailError('mail_provider_not_configured', { target: binding.targetName });
  }

  let finalSubject = String(subject || '');
  let finalHtml = html;
  if (plan.redirected) {
    finalSubject = `[SINK] ${finalSubject}`;
    const banner =
      `<div style="background:#fff3cd;border:1px solid #ffe08a;padding:12px 14px;margin-bottom:16px;` +
      `font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5c4400;">` +
      `<strong>Non-production email.</strong> Intended recipient: ` +
      `${plan.intended.map(a => a.replace(/[<>&]/g, '')).join(', ')} — redirected here because that ` +
      `address is not on this environment's allowlist.</div>`;
    finalHtml = banner + (html || '');
  }

  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${binding.resendApiKey}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        from: from || 'Demohub <hello@demohubhq.com>',
        to: plan.to,
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject: finalSubject,
        ...(finalHtml ? { html: finalHtml } : {}),
        ...(text ? { text } : {}),
      }),
    });
  } catch (e) {
    // No response: the request may or may not have reached the provider. Report that honestly —
    // never as a definite failure. No payload in the log.
    console.error('MAIL_PROVIDER_UNREACHABLE', JSON.stringify({ target: binding.targetName, mode: plan.mode, aborted: !!(controller && controller.signal.aborted) }));
    throw new MailError('mail_provider_unreachable', { aborted: !!(controller && controller.signal.aborted) });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); detail = j.message || detail; } catch (_) {}
    // Log the failure WITHOUT the payload.
    console.error('MAIL_SEND_FAILED', JSON.stringify({
      target: binding.targetName, mode: plan.mode, redirected: plan.redirected,
      recipients: plan.to.length, status: res.status,
    }));
    throw new MailError('mail_send_failed', detail);
  }

  // The provider's message id ("accepted by the provider", not "delivered") for callers that record it.
  let id = null;
  try { const j = await res.json(); id = (j && j.id) ? String(j.id) : null; } catch (_) {}
  return { ok: true, mode: plan.mode, redirected: plan.redirected, delivered: plan.to.length, id };
}

// Best-effort variant for genuinely non-blocking notifications (staff alerts, welcome nudges).
// Still goes through every containment check — "best effort" governs error handling, never
// whether the allowlist applies.
export async function sendMailQuietly(msg, opts = {}) {
  try { return await sendMail(msg, opts); }
  catch (e) {
    const code = (e && e.code) || 'unknown';
    console.warn('MAIL_NON_FATAL', JSON.stringify({ code }));   // no payload, no recipient
    return { ok: false, code };
  }
}

// Re-exported so routes build links from the bound origin without importing _env directly.
export { link, BindingError };
