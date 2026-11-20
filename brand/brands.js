// /brand/brands.js (0121, 2026-11-19): one person, many brands. One small script shared by the sign-in page, the brand
// portal and the booking page, so the picker, the switcher and the "Booking for" line look and behave the same
// everywhere.
//
//   DHBrands.renderPicker(el, opts)   the list of the person's brands (own brand first), their pending invitations and
//                                     "Add another brand". Reads /api/brand-account?action=brand-list itself.
//   DHBrands.open(opts)               the same picker in a dialog (header switcher, "Switch brand" on the booking page)
//   DHBrands.mountSwitcher(el, data)  the header button that names the active brand and opens the dialog
//   DHBrands.switchTo(id)             one click: the server checks access, rotates the session, the page reloads
//   DHBrands.guard(brandId)           stamps every API call from this page with the brand the page is SHOWING. If the
//                                     person switched brand in another tab the server answers 409 brand_changed and this
//                                     page stops and asks for a reload, so nothing is ever saved to the wrong brand.
//
// The server is the authority for everything here: which brands are listed, whether a switch is allowed, and whether an
// invitation or request is valid. This file only draws what the server says.
/* global window, document, fetch, location, localStorage, Headers, Request */
(function () {
  'use strict';
  var KEY = 'dh_active_brand';
  var state = { activeId: null, guarded: false, blocked: false };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var LABEL = { owner: 'Your account', full: 'Full access', booking: 'Booking only' };

  function css() {
    if (document.getElementById('dhBrandsCss')) return;
    var st = document.createElement('style'); st.id = 'dhBrandsCss';
    st.textContent = [
      '.dhb-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.dhb-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#fff;border:1.5px solid rgba(15,44,23,0.16);border-radius:14px;padding:12px 14px;cursor:pointer;font:inherit;color:#1c1c1a;min-height:60px}',
      '.dhb-row:hover,.dhb-row:focus-visible{border-color:#0f2c17;outline:none;box-shadow:0 0 0 3px rgba(15,44,23,0.10)}',
      '.dhb-row.is-active{border-color:#0f2c17;background:#f1f6ee}',
      '.dhb-row[disabled]{opacity:.6;cursor:default}',
      '.dhb-av{flex:0 0 38px;width:38px;height:38px;border-radius:50%;background:#0f2c17;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;overflow:hidden}',
      '.dhb-av img{width:100%;height:100%;object-fit:cover}',
      '.dhb-main{flex:1;min-width:0}',
      '.dhb-name{display:block;font-weight:700;font-size:1rem;color:#0f2c17;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dhb-sub{display:block;font-size:.82rem;color:#3a3a36;line-height:1.3;margin-top:2px}',
      '.dhb-chip{flex:0 0 auto;font-size:.72rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:999px;padding:3px 10px;white-space:nowrap}',
      '.dhb-chip.own{background:#0f2c17;color:#fff}.dhb-chip.cur{background:#2a5b32;color:#fff}.dhb-chip.go{background:transparent;color:#0f2c17;font-size:1.1rem;padding:0 4px}',
      '.dhb-h{font-size:.74rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#a14e2a;margin:18px 0 8px}',
      '.dhb-inv .dhb-main{flex:1 1 170px}',
      '.dhb-inv .dhb-sub{overflow-wrap:anywhere}',
      '.dhb-inv{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#fff8ec;border:1.5px solid #e2c48a;border-radius:14px;padding:12px 14px}',
      '.dhb-btn{font:inherit;font-weight:700;font-size:.9rem;border-radius:999px;padding:9px 18px;cursor:pointer;border:1.5px solid #0f2c17;background:#0f2c17;color:#fff;white-space:nowrap}',
      '.dhb-btn.ghost{background:#fff;color:#0f2c17}',
      '.dhb-btn[disabled]{opacity:.6;cursor:default}',
      '.dhb-link{background:none;border:0;padding:0;font:inherit;font-weight:600;color:#0f2c17;text-decoration:underline;cursor:pointer}',
      '.dhb-form{display:none;margin-top:12px;background:#fff;border:1.5px solid rgba(15,44,23,0.16);border-radius:14px;padding:16px}',
      '.dhb-form.open{display:block}',
      '.dhb-form label{display:block;font-size:.84rem;font-weight:600;color:#1c1c1a;margin:10px 0 4px}',
      '.dhb-form input[type=email],.dhb-form input[type=text],.dhb-form select{width:100%;font:inherit;font-size:1rem;padding:11px 12px;border:1.5px solid rgba(15,44,23,0.28);border-radius:10px;background:#fff;color:#1c1c1a;box-sizing:border-box}',
      '.dhb-note{font-size:.84rem;color:#3a3a36;line-height:1.5;margin:8px 0 0}',
      '.dhb-msg{font-size:.9rem;line-height:1.45;margin-top:10px;min-height:1em;color:#0f2c17;font-weight:600}',
      '.dhb-msg.bad{color:#a14e2a}',
      '.dhb-overlay{position:fixed;inset:0;background:rgba(15,44,23,0.55);z-index:10050;display:flex;align-items:center;justify-content:center;padding:20px}',
      '.dhb-dialog{background:#fbf7f0;border-radius:20px;width:100%;max-width:480px;max-height:calc(100vh - 40px);overflow:auto;padding:26px 24px 22px;box-shadow:0 24px 60px rgba(0,0,0,0.3);font-family:"Hanken Grotesk",-apple-system,sans-serif;color:#1c1c1a}',
      '.dhb-dialog h2{font-family:"Fraunces",Georgia,serif;font-variation-settings:"opsz" 60,"SOFT" 100,"WONK" 1;font-weight:620;font-size:1.5rem;line-height:1.2;color:#0f2c17;margin:0 0 6px}',
      '.dhb-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dhb-x{background:#fff;border:1.5px solid rgba(15,44,23,0.2);border-radius:50%;width:36px;height:36px;font-size:1.1rem;line-height:1;cursor:pointer;color:#0f2c17;flex:0 0 auto}',
      '.dhb-switch{display:inline-flex;align-items:center;gap:8px;font:inherit;background:#fff;border:1.5px solid rgba(15,44,23,0.28);border-radius:999px;padding:6px 12px 6px 8px;cursor:pointer;color:#0f2c17;max-width:260px}',
      '.dhb-switch:hover,.dhb-switch:focus-visible{border-color:#0f2c17;outline:none}',
      '.dhb-switch .dhb-av{flex-basis:26px;width:26px;height:26px;font-size:.78rem}',
      '.dhb-switch-txt{display:flex;flex-direction:column;align-items:flex-start;min-width:0;line-height:1.15}',
      '.dhb-switch-k{font-size:.66rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#3a3a36}',
      '.dhb-switch-v{font-size:.92rem;font-weight:700;color:#0f2c17;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dhb-caret{font-size:.7rem;color:#0f2c17}',
      '.dhb-for{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;font-size:.95rem;color:#1c1c1a;line-height:1.4}',
      '.dhb-for strong{color:#0f2c17;font-weight:700}',
      '@media (max-width:520px){.dhb-overlay{align-items:flex-end;padding:0}.dhb-dialog{border-radius:20px 20px 0 0;max-width:none;max-height:88vh;padding:22px 16px 18px}.dhb-row{padding:12px}}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function api(body) {
    return fetch('/api/brand-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .catch(function () { return { ok: false, status: 0, body: {} }; });
  }
  function avatar(b) {
    var n = String((b && b.company_name) || '?').trim();
    return '<span class="dhb-av" aria-hidden="true">' + (b && b.logo_url ? '<img src="' + esc(b.logo_url) + '" alt="">' : esc(n.charAt(0).toUpperCase() || '?')) + '</span>';
  }
  function subFor(b) {
    if (b.is_own) return 'Your own brand account';
    return b.access === 'full' ? 'Full access: you can manage this brand' : 'Booking only: you can book demos for this brand';
  }

  // One click. The server checks that this sign-in may use the brand and replaces the session; the page then reloads so
  // every list, item and certificate on screen belongs to the new brand.
  function switchTo(brandId, opts) {
    opts = opts || {};
    return api({ action: 'brand-switch', brand_id: brandId }).then(function (r) {
      if (!r.ok) return r;
      state.activeId = brandId;
      try { localStorage.setItem(KEY, brandId + '|' + Date.now()); } catch (_) { /* private mode: the server check still holds */ }
      if (typeof opts.onSwitched === 'function') opts.onSwitched(r.body);
      else location.reload();
      return r;
    });
  }

  function renderPicker(el, opts) {
    css(); opts = opts || {};
    el.innerHTML = '<p class="dhb-note">Loading your brands.</p>';
    return api({ action: 'brand-list' }).then(function (r) {
      if (!r.ok || !r.body || r.body.multi_brand !== true) { el.innerHTML = ''; if (typeof opts.onUnavailable === 'function') opts.onUnavailable(r); return r; }
      var d = r.body, brands = d.brands || [], invites = d.invites || [];
      var active = opts.activeId || d.active_brand_id || state.activeId;
      state.activeId = d.active_brand_id || state.activeId;
      var h = '';
      h += '<ul class="dhb-list" data-dhb="brands">' + brands.map(function (b) {
        var cur = String(b.brand_id) === String(active);
        return '<li><button type="button" class="dhb-row' + (cur ? ' is-active' : '') + '" data-brand="' + esc(b.brand_id) + '" aria-current="' + (cur ? 'true' : 'false') + '">'
          + avatar(b) + '<span class="dhb-main"><span class="dhb-name">' + esc(b.company_name) + '</span><span class="dhb-sub">' + esc(subFor(b)) + '</span></span>'
          + (b.is_own ? '<span class="dhb-chip own">Yours</span>' : '')
          + (cur && opts.markCurrent !== false ? '<span class="dhb-chip cur">Current</span>' : '<span class="dhb-chip go" aria-hidden="true">&rsaquo;</span>')
          + '</button></li>';
      }).join('') + '</ul>';
      if (invites.length) {
        h += '<div class="dhb-h">Invitations waiting for you</div><div class="dhb-list" data-dhb="invites">' + invites.map(function (i) {
          return '<div class="dhb-inv" data-invite="' + esc(i.member_id) + '">' + avatar(i)
            + '<span class="dhb-main"><span class="dhb-name">' + esc(i.company_name) + '</span><span class="dhb-sub">' + esc(LABEL[i.access] || 'Booking only') + (i.invited_by_email ? ', invited by ' + esc(i.invited_by_email) : '') + '</span></span>'
            + '<button type="button" class="dhb-btn" data-accept="' + esc(i.member_id) + '" data-brand="' + esc(i.brand_id) + '">Accept</button>'
            + '<button type="button" class="dhb-link" data-decline="' + esc(i.member_id) + '">Decline</button></div>';
        }).join('') + '</div><p class="dhb-note">Accepting means you agree to <a href="' + esc(d.terms_url || '/terms') + '" target="_blank" rel="noopener" style="color:#0f2c17;font-weight:600;">Demohub\'s Terms of Service</a> for that brand too. Demos you book there are made in that brand\'s name, under its insurance and agreements.</p>';
      }
      if (opts.allowRequest !== false) {
        h += '<div style="margin-top:16px;"><button type="button" class="dhb-link" data-dhb="add">Add another brand</button></div>'
          + '<form class="dhb-form" data-dhb="form" novalidate>'
          + '<div style="font-weight:700;color:#0f2c17;font-size:1rem;">Ask a brand for access</div>'
          + '<p class="dhb-note">Enter the email the brand signs in to Demohub with. The brand\'s owner gets an email and approves with one button. Nothing changes until they do.</p>'
          + '<label for="dhbOwnerEmail">The brand\'s Demohub sign-in email</label><input id="dhbOwnerEmail" type="email" autocomplete="off" placeholder="owner@theirbrand.com" required>'
          + '<label for="dhbLevel">What you need</label><select id="dhbLevel"><option value="booking">Booking only: book demos and pick their saved items</option><option value="full">Full access: also items, insurance, payments and store agreements</option></select>'
          + '<label for="dhbNote">A note for the owner (optional)</label><input id="dhbNote" type="text" maxlength="300" placeholder="e.g. I run your demos with Healthy Bites">'
          + '<p class="dhb-note">Sending the request means you agree to <a href="' + esc(d.terms_url || '/terms') + '" target="_blank" rel="noopener" style="color:#0f2c17;font-weight:600;">Demohub\'s Terms of Service</a> for that brand too.</p>'
          + '<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;"><button type="submit" class="dhb-btn">Send request</button><button type="button" class="dhb-btn ghost" data-dhb="cancel">Cancel</button></div>'
          + '</form>';
      }
      h += '<div class="dhb-msg" data-dhb="msg" role="status" aria-live="polite"></div>';
      el.innerHTML = h;
      var msg = function (t, bad) { var m = el.querySelector('[data-dhb="msg"]'); if (m) { m.textContent = t || ''; m.className = 'dhb-msg' + (bad ? ' bad' : ''); } };
      var busy = function (on) { el.querySelectorAll('button').forEach(function (b) { b.disabled = !!on; }); };

      el.querySelectorAll('.dhb-row').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-brand');
          if (String(id) === String(d.active_brand_id)) { if (typeof opts.onSame === 'function') opts.onSame(id); else if (typeof opts.onSwitched === 'function') opts.onSwitched({ brand_id: id, changed: false }); return; }
          if (typeof opts.confirmSwitch === 'function' && !opts.confirmSwitch(id)) return;
          busy(true); msg('Switching brand.');
          switchTo(id, { onSwitched: opts.onSwitched }).then(function (sr) { if (!sr.ok) { busy(false); msg((sr.body && sr.body.message) || 'Could not switch brand. Try again.', true); } });
        });
      });
      el.querySelectorAll('[data-accept]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          busy(true); msg('');
          api({ action: 'access-accept', member_id: btn.getAttribute('data-accept'), terms_accepted: true, terms_version: d.terms_version }).then(function (ar) {
            if (!ar.ok) { busy(false); msg((ar.body && ar.body.message) || 'Could not accept the invitation. Try again.', true); return; }
            if (typeof opts.onAccepted === 'function') { opts.onAccepted(ar.body); return; }
            renderPicker(el, opts).then(function () { var m2 = el.querySelector('[data-dhb="msg"]'); if (m2) m2.textContent = 'Added. Pick the brand to start working on it.'; });
          });
        });
      });
      el.querySelectorAll('[data-decline]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          busy(true);
          api({ action: 'access-leave', member_id: btn.getAttribute('data-decline') }).then(function () { renderPicker(el, opts); });
        });
      });
      var add = el.querySelector('[data-dhb="add"]'), form = el.querySelector('[data-dhb="form"]');
      if (add && form) {
        add.addEventListener('click', function () { form.classList.add('open'); add.style.display = 'none'; var i = form.querySelector('#dhbOwnerEmail'); if (i) i.focus(); });
        form.querySelector('[data-dhb="cancel"]').addEventListener('click', function () { form.classList.remove('open'); add.style.display = ''; msg(''); });
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var email = (form.querySelector('#dhbOwnerEmail').value || '').trim();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg('Enter the email the brand signs in with.', true); return; }
          busy(true); msg('');
          api({ action: 'access-request', owner_email: email, access: form.querySelector('#dhbLevel').value, note: form.querySelector('#dhbNote').value || '', terms_accepted: true }).then(function (rr) {
            busy(false);
            if (!rr.ok) { msg((rr.body && rr.body.message) || 'Could not send the request. Try again.', true); return; }
            form.reset(); form.classList.remove('open'); add.style.display = '';
            msg((rr.body && rr.body.message) || 'Request sent.');
          });
        });
      }
      if (typeof opts.onReady === 'function') opts.onReady(d);
      return r;
    });
  }

  function close() { var o = document.getElementById('dhBrandsOverlay'); if (o) o.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open(opts) {
    css(); opts = opts || {}; close();
    var o = document.createElement('div'); o.className = 'dhb-overlay'; o.id = 'dhBrandsOverlay';
    o.innerHTML = '<div class="dhb-dialog" role="dialog" aria-modal="true" aria-labelledby="dhBrandsTitle"><div class="dhb-top"><div><h2 id="dhBrandsTitle">' + esc(opts.title || 'Which brand are you working on?') + '</h2>'
      + '<p class="dhb-note" style="margin:0 0 14px;">' + esc(opts.note || 'Every demo you book is made in the name of the brand you pick, with its items and its insurance.') + '</p></div>'
      + (opts.dismissable === false ? '' : '<button type="button" class="dhb-x" aria-label="Close" data-dhb="x">&times;</button>') + '</div><div data-dhb="body"></div></div>';
    document.body.appendChild(o);
    if (opts.dismissable !== false) {
      o.addEventListener('click', function (e) { if (e.target === o) close(); });
      o.querySelector('[data-dhb="x"]').addEventListener('click', close);
      document.addEventListener('keydown', onKey);
    }
    var inner = Object.assign({}, opts, { onSame: function () { close(); if (typeof opts.onSame === 'function') opts.onSame(); } });
    return renderPicker(o.querySelector('[data-dhb="body"]'), inner);
  }

  // The header button: always names the brand being worked on. Shown when the person has more than one brand or an
  // invitation waiting; a person with one brand keeps today's header.
  function mountSwitcher(el, data, opts) {
    css(); opts = opts || {};
    if (!el || !data || data.multi_brand !== true) { if (el) el.innerHTML = ''; return false; }
    var a = data.active_brand || {}, n = (data.brands || []).length, inv = (data.invites || []).length;
    state.activeId = a.brand_id || state.activeId;
    if (n < 2 && !inv) { el.innerHTML = ''; return false; }
    var cur = (data.brands || []).filter(function (b) { return String(b.brand_id) === String(a.brand_id); })[0] || { company_name: a.company_name };
    el.innerHTML = '<button type="button" class="dhb-switch" id="dhBrandSwitch" aria-haspopup="dialog" title="Switch brand">' + avatar(cur)
      + '<span class="dhb-switch-txt"><span class="dhb-switch-k">' + esc(opts.label || 'Working on') + '</span><span class="dhb-switch-v">' + esc(a.company_name || cur.company_name || '') + '</span></span>'
      + (inv ? '<span class="dhb-chip own" title="Invitations waiting">' + inv + '</span>' : '') + '<span class="dhb-caret" aria-hidden="true">&#9662;</span></button>';
    el.querySelector('#dhBrandSwitch').addEventListener('click', function () { open(opts.dialog || {}); });
    return true;
  }

  // The "Booking for" line of the booking page and the portal band on a phone.
  function forLine(el, data, opts) {
    css(); opts = opts || {};
    if (!el) return false;
    if (!data || data.multi_brand !== true || !data.active_brand) { el.innerHTML = ''; el.style.display = 'none'; return false; }
    var a = data.active_brand, many = (data.brands || []).length > 1, inv = (data.invites || []).length;
    state.activeId = a.brand_id || state.activeId;
    if (opts.onlyIfMany && !many && !inv) { el.innerHTML = ''; el.style.display = 'none'; return false; }
    el.innerHTML = '<div class="dhb-for"><span>' + esc(opts.prefix || 'Booking for') + ' <strong data-dhb="for-name">' + esc(a.company_name) + '</strong>'
      + (a.access === 'owner' ? '' : ' <span style="color:#3a3a36;">(' + esc(LABEL[a.access] || '') + ')</span>') + '</span>'
      + ((many || inv) ? '<button type="button" class="dhb-link" data-dhb="for-switch">' + esc(opts.switchLabel || 'Switch brand') + (inv ? ' (' + inv + ' invitation' + (inv > 1 ? 's' : '') + ')' : '') + '</button>' : '') + '</div>';
    el.style.display = '';
    var b = el.querySelector('[data-dhb="for-switch"]');
    if (b) b.addEventListener('click', function () { open(opts.dialog || {}); });
    return true;
  }

  // Stale-tab protection. Every API call from a guarded page says which brand the page is showing. The server compares
  // it with the session and refuses a mismatch, and this page then stops with a reload prompt.
  function blockPage(name) {
    if (state.blocked) return; state.blocked = true; css(); close();
    var o = document.createElement('div'); o.className = 'dhb-overlay'; o.id = 'dhBrandsBlocked';
    o.innerHTML = '<div class="dhb-dialog" role="alertdialog" aria-modal="true" aria-labelledby="dhBlockedTitle"><h2 id="dhBlockedTitle">You switched brand in another tab</h2>'
      + '<p class="dhb-note" style="font-size:.95rem;margin:6px 0 16px;">This page is still showing ' + (name ? '<strong>' + esc(name) + '</strong>' : 'the earlier brand') + '. Reload it so that what you see and what you book belong to the brand you are working on now. Nothing was saved to the wrong brand.</p>'
      + '<button type="button" class="dhb-btn" id="dhBlockedReload">Reload this page</button></div>';
    document.body.appendChild(o);
    document.getElementById('dhBlockedReload').addEventListener('click', function () { location.reload(); });
  }
  function guard(brandId, brandName) {
    if (!brandId) return;
    state.activeId = brandId; state.guardName = brandName || state.guardName || '';
    if (state.guarded) return; state.guarded = true;
    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameApi = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;
      if (!sameApi || !state.activeId) return orig(input, init);
      init = Object.assign({}, init || {});
      var h = new Headers(init.headers || ((typeof Request !== 'undefined' && input instanceof Request) ? input.headers : undefined));
      h.set('X-DH-Brand', state.activeId); init.headers = h;
      return orig(input, init).then(function (res) {
        if (res.status === 409) { res.clone().json().then(function (j) { if (j && j.error === 'brand_changed') blockPage(state.guardName); }).catch(function () {}); }
        return res;
      });
    };
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY || !e.newValue) return;
      if (String(e.newValue).split('|')[0] !== String(state.activeId)) blockPage(state.guardName);
    });
  }

  window.DHBrands = { renderPicker: renderPicker, open: open, close: close, mountSwitcher: mountSwitcher, forLine: forLine, switchTo: switchTo, guard: guard, labels: LABEL };
})();
