// tests/mail_deadline.test.mjs — Codex Release B round 4, R4-03 C.
//
// sendMail's deadline must cover the WHOLE provider exchange: request, headers AND body. Before this
// the abort timer was cleared once headers arrived, so a stalled body left a send pending past its
// advertised bound. Every stub below either honours the AbortSignal or deliberately IGNORES it; in
// both cases the call must settle within the bound with an honest classification:
//   * no headers in time                 -> mail_provider_unreachable (aborted, stage request)
//   * success headers, stalled body      -> mail_provider_unreachable (aborted, stage body)  — never "ok"
//   * error headers, stalled body        -> mail_send_failed (definite refusal, detail notes the stall)
//   * success headers, malformed body    -> mail_ack_unverified — never "ok"
//   * success headers, {id}              -> ok with the id;  {} -> ok, id null (the provider did answer 2xx)
// Pure: a fetch stub, no network, no database.
import { sendMail } from '../api/_mail.js';
import { getBinding, _resetBindingCache } from '../api/_env.js';
import { ENV, ok, summary } from './_route.mjs';

process.env = { ...ENV }; _resetBindingCache();
const b = await getBinding();
const BOUND = 60;                // the advertised deadline for every call below
const SLACK = 1500;              // generous ceiling: the call must settle well inside this

const abortErr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const never = () => new Promise(() => {});
const untilAbort = (signal) => new Promise((_, reject) => {
  if (!signal) return;                       // ignores nothing — but with no signal it hangs forever by design
  if (signal.aborted) return reject(abortErr());
  signal.addEventListener('abort', () => reject(abortErr()), { once: true });
});
const res = (status, body) => ({ ok: status < 400, status, json: body, text: async () => '' });

const attempt = async (label, fetchStub, expect) => {
  const t0 = Date.now();
  let out = null, err = null;
  try { out = await sendMail({ to: 'deadline@fixture.test', subject: 'deadline ' + label, html: '<p>x</p>' }, { binding: b, fetch: fetchStub, timeoutMs: BOUND, idempotencyKey: 'dl-' + label }); }
  catch (e) { err = e; }
  const ms = Date.now() - t0;
  const code = err ? err.code : (out && out.ok ? 'ok' : 'unexpected');
  const detail = err ? err.detail : out;
  const pass = code === expect.code && ms < SLACK && (!expect.aborted || (detail && detail.aborted === true)) && (!expect.stage || (detail && detail.stage === expect.stage)) && (!expect.detailMatch || expect.detailMatch.test(String(detail))) && (expect.id === undefined || (out && out.id === expect.id));
  ok(`${label}: settles in ${ms}ms as ${expect.code}${expect.aborted ? ' (aborted)' : ''}${expect.stage ? ' at ' + expect.stage : ''}`, pass, JSON.stringify({ code, ms, detail }));
};

console.log('\n— mail deadline (Codex R4-03 C): the bound covers headers AND body; stalled/malformed acknowledgments are never "ok" —');

// headers never arrive
await attempt('slow headers (honours the signal)', (u, o) => untilAbort(o.signal), { code: 'mail_provider_unreachable', aborted: true, stage: 'request' });

// success headers, the acknowledgment body stalls
await attempt('200 + stalled body (honours the signal)', async (u, o) => res(200, () => untilAbort(o.signal)), { code: 'mail_provider_unreachable', aborted: true, stage: 'body' });
await attempt('200 + stalled body (IGNORES the signal)', async () => res(200, never), { code: 'mail_provider_unreachable', aborted: true, stage: 'body' });

// error headers, the error body stalls: still a definite refusal, still within the bound
await attempt('500 + stalled body (honours the signal)', async (u, o) => res(500, () => untilAbort(o.signal)), { code: 'mail_send_failed', detailMatch: /HTTP 500 \(error body stalled/ });
await attempt('429 + stalled body (IGNORES the signal)', async () => res(429, never), { code: 'mail_send_failed', detailMatch: /HTTP 429 \(error body stalled/ });

// success headers, unparseable / non-object acknowledgment
await attempt('200 + malformed JSON body', async () => res(200, async () => { throw new SyntaxError('Unexpected token <'); }), { code: 'mail_ack_unverified', stage: 'body' });
await attempt('200 + non-object body', async () => res(200, async () => 'accepted'), { code: 'mail_ack_unverified', stage: 'body' });

// the provider answered properly
await attempt('200 + {id}', async () => res(200, async () => ({ id: 'msg_dl_1' })), { code: 'ok', id: 'msg_dl_1' });
await attempt('200 + {} (no id)', async () => res(200, async () => ({})), { code: 'ok', id: null });
await attempt('422 + {message}', async () => res(422, async () => ({ message: 'validation error' })), { code: 'mail_send_failed', detailMatch: /validation error/ });

// a slow-but-successful body inside the bound is accepted (the deadline is a ceiling, not a race to lose)
await attempt('200 + body after 10ms', async () => res(200, () => new Promise(r => setTimeout(() => r({ id: 'msg_dl_2' }), 10))), { code: 'ok', id: 'msg_dl_2' });

process.exit(summary('mail deadline (Codex R4-03 C)') ? 0 : 1);
