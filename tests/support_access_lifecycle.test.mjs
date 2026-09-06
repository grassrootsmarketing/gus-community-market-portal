// Offline lifecycle regressions. Every network call is replaced, including provider calls.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import handler from '../api/admin-auth.js';
import { TARGETS, _resetBindingCache } from '../api/_env.js';

const realEnv = process.env, realFetch = globalThis.fetch, realRef = TARGETS.preview.projectRef;
const REF = 'bbbbbbbbbbbbbbbbbbbb';
const SID = '11111111-1111-4111-8111-111111111111';
const RID = '33333333-3333-4333-8333-333333333333';
const AID = '44444444-4444-4444-8444-444444444444';
const future = () => new Date(Date.now() + 3600000).toISOString();
const response = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });

function fixture({ support = true, fault = null, ended = false, consent = null, revokeAfterMembership = false } = {}) {
  TARGETS.preview.projectRef = REF;
  process.env = {
    VERCEL_ENV: 'preview', SUPABASE_URL: `https://${REF}.supabase.co`,
    SUPABASE_SERVICE_KEY: 'fake', SITE_ORIGIN: 'https://staging.example.test',
    EMAIL_ALLOWLIST: 'sink@fixture.test', RESEND_API_KEY: 'fake',
  };
  _resetBindingCache();
  const state = {
    live: true, calls: [], emails: [],
    consent: consent || { allow_support_access: true, support_access_expires_at: future() },
    audit: support ? { id: AID, target_session_id: SID, target_retailer_id: RID,
      owner_email: 'david@demohubhq.com', started_at: new Date(Date.now() - 600000).toISOString(),
      ended_at: ended ? new Date().toISOString() : null, writes_count: 0 } : null,
  };
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET', path = String(url).split('/rest/v1/')[1];
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.calls.push({ path, method, body });
    if (url === 'https://api.resend.com/emails') { state.emails.push(body); return response({}); }
    if (path === 'rpc/get_deployment_identity') return response([{ environment: 'staging', project_ref: REF }]);
    if (path?.startsWith('admin_sessions?')) {
      if (method === 'DELETE') {
        if (fault === 'delete') return response({ message: 'injected session deletion failure' }, 503);
        state.live = false;
        if (state.audit) state.audit.target_session_id = null; // database FK behavior
        return response([]);
      }
      return response(state.live ? [{ session_id: SID, retailer_id: RID, email: 'billing@fixture.test', expires_at: future() }] : []);
    }
    if (path?.startsWith('retailer_admins?')) {
      // A concurrent OFF commits just after a membership read. Its FK update erases the pointer.
      if (revokeAfterMembership && state.audit) { state.live = false; state.audit.target_session_id = null; }
      return response([{ id: 'member', role: 'owner', venue_ids: [] }]);
    }
    if (path?.startsWith('retailers?')) return response([{ id: RID, name: 'Fixture', billing_email: 'sink@fixture.test', ...state.consent }]);
    if (path?.startsWith('support_sessions?')) {
      if (method === 'PATCH') {
        if (fault === 'audit-update') return response({ message: 'injected audit update failure' }, 503);
        const matches = state.audit && (path.includes(`id=eq.${AID}`) ||
          (path.includes(`target_session_id=eq.${SID}`) && state.audit.target_session_id === SID));
        if (matches) state.audit.ended_at = body.ended_at;
        return response([]);
      }
      if (fault === 'audit-lookup') return response({ message: 'injected audit lookup failure' }, 503);
      if (fault === 'malformed-lookup') return response(null);
      return response(state.audit?.target_session_id === SID &&
        (!path.includes('ended_at=is.null') || !state.audit.ended_at) ? [{ ...state.audit }] : []);
    }
    if (path === 'rpc/support_access_set') {
      state.consent = { allow_support_access: body.p_enabled,
        support_access_expires_at: body.p_enabled ? new Date(Date.now() + 86400000).toISOString() : null };
      return response([{ ...state.consent, ended_sessions: 0 }]);
    }
    throw new Error(`Unexpected offline request: ${method} ${url}`);
  };
  state.call = async (action, body = {}) => {
    const res = {
      statusCode: 200, headers: {}, status(n) { this.statusCode = n; return this; },
      json(value) { this.body = value; return this; },
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, end() {},
    };
    // Intentionally no dh_support marker or owner cookie: neither proves session origin.
    await handler({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin', cookie: `dh_retailer_session=${SID}` },
      query: {}, body: { action, ...body } }, res);
    return res;
  };
  return state;
}

after(() => {
  process.env = realEnv; globalThis.fetch = realFetch; TARGETS.preview.projectRef = realRef; _resetBindingCache();
});

for (const enabled of [true, false]) {
  test(`support cannot change consent to ${enabled}, without trusting a marker cookie`, async () => {
    const f = fixture(), before = { ...f.consent };
    const res = await f.call('support-access-toggle', { enabled });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'support_cannot_change_consent');
    assert.deepEqual(f.consent, before);
    assert.ok(!f.calls.some(c => c.path === 'rpc/support_access_set'));
  });
}

test('an ended audit with a still-live session also cannot renew consent', async () => {
  const f = fixture({ ended: true });
  assert.equal((await f.call('support-access-toggle', { enabled: true })).statusCode, 403);
  assert.ok(!f.calls.some(c => c.path === 'rpc/support_access_set'));
});

test('concurrent revocation cannot disguise support as ordinary staff by clearing the audit pointer', async () => {
  const f = fixture({ revokeAfterMembership: true });
  assert.equal((await f.call('support-access-toggle', { enabled: true })).statusCode, 403);
  assert.ok(!f.calls.some(c => c.path === 'rpc/support_access_set'));
});

test('a previously revoked support session is refused after its audit pointer has been cleared', async () => {
  const f = fixture(); f.live = false; f.audit.target_session_id = null;
  assert.equal((await f.call('support-access-toggle', { enabled: true })).statusCode, 401);
  assert.ok(!f.calls.some(c => c.path === 'rpc/support_access_set'));
});

for (const fault of ['audit-lookup', 'malformed-lookup']) {
  test(`consent fails closed when support origin is unavailable: ${fault}`, async () => {
    const f = fixture({ support: false, fault });
    const res = await f.call('support-access-toggle', { enabled: true });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'support_session_check_unavailable');
    assert.ok(!f.calls.some(c => c.path === 'rpc/support_access_set'));
  });
}

test('ordinary retailer staff can still enable and disable support consent', async () => {
  const f = fixture({ support: false });
  for (const enabled of [true, false]) {
    const res = await f.call('support-access-toggle', { enabled });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.allow_support_access, enabled);
  }
});

for (const fault of ['audit-lookup', 'delete']) {
  test(`exit failure preserves the open audit and reports failure: ${fault}`, async () => {
    const f = fixture({ fault });
    const res = await f.call('owner-end-impersonation');
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'support_session_end_failed');
    assert.equal(f.live, true);
    assert.equal(f.audit.ended_at, null);
    assert.ok(!f.calls.some(c => c.method === 'PATCH'));
    assert.equal(res.headers['Set-Cookie'], undefined);
    assert.equal(f.emails.length, 0);
    if (fault === 'audit-lookup') assert.ok(!f.calls.some(c => c.method === 'DELETE'));
  });
}

test('successful exit revokes before ending the audit, despite the FK clearing its session pointer', async () => {
  const f = fixture();
  const res = await f.call('owner-end-impersonation');
  assert.equal(res.statusCode, 200);
  assert.equal(f.live, false);
  assert.equal(f.audit.target_session_id, null);
  assert.ok(f.audit.ended_at);
  const deleted = f.calls.findIndex(c => c.method === 'DELETE');
  const marked = f.calls.findIndex(c => c.method === 'PATCH');
  assert.ok(deleted >= 0 && marked > deleted);
  assert.ok(f.calls[marked].path.startsWith(`support_sessions?id=eq.${AID}`));
  assert.ok(res.headers['Set-Cookie'].every(c => c.includes('Max-Age=0')));
  assert.equal(f.emails.length, 1);
});

test('audit update failure after revocation cannot leave a usable session or claim success', async () => {
  const f = fixture({ fault: 'audit-update' });
  const res = await f.call('owner-end-impersonation');
  assert.equal(res.statusCode, 503);
  assert.equal(f.live, false);
  assert.equal(f.audit.ended_at, null);
  assert.equal(f.emails.length, 0);
  assert.equal(res.headers['Set-Cookie'], undefined);
  // Retrying is safe even though the revoked session can no longer resolve its audit pointer.
  assert.equal((await f.call('owner-end-impersonation')).statusCode, 200);
});

for (const [label, consent, expected] of [
  ['valid', { allow_support_access: true, support_access_expires_at: future() }, true],
  ['off', { allow_support_access: false, support_access_expires_at: future() }, false],
  ['missing expiry', { allow_support_access: true, support_access_expires_at: null }, false],
  ['invalid expiry', { allow_support_access: true, support_access_expires_at: 'invalid' }, false],
  ['expired', { allow_support_access: true, support_access_expires_at: '2000-01-01T00:00:00Z' }, false],
]) {
  test(`status reports consent consistently with session creation: ${label}`, async () => {
    const f = fixture({ support: false, consent });
    const res = await f.call('support-access-status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.allow_support_access, expected);
    assert.equal(typeof res.body.expired, 'boolean');
  });
}
