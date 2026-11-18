// api/_code-email.js: the one look for every "here is your 6-digit code" email (store sign-up, brand sign-in and sign-up).
// It is the same card as the store sign-in email (magicLinkEmail in api/admin-auth.js): dark green header with the
// Demohub mark, a small eyebrow, an optional heading, the code in large type between two rules, the expiry, the footer.
// A sign-up code has no link to click (the code is typed into the page the person already has open), so there is no
// button here; a button that led nowhere useful would be worse than none.
//
// Keep every colour and number in this file free of six digits in a row: tests read the code back out of the html
// with /(\d{6})/ and must find the real code first.

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MARK = '<svg width="36" height="36" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><defs><radialGradient id="dhOrange" cx="0.36" cy="0.30" r="0.78"><stop offset="0" stop-color="#ff9a5c"/><stop offset="0.45" stop-color="#ed682f"/><stop offset="0.85" stop-color="#b8471a"/><stop offset="1" stop-color="#9a3a13"/></radialGradient></defs><circle cx="36" cy="40" r="18" fill="url(#dhOrange)"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>';

// eyebrow: short line above the heading. heading: optional (a store or account name). label: line above the code.
// minutes: how long the code lasts. hint: one plain sentence saying what to do with the code. reason: footer line
// saying why this address got the email.
export function codeEmail({ eyebrow, heading, label, code, minutes, hint, reason }) {
  const head = heading ? `<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#0f2c17;margin:0 0 28px;">${esc(heading)}</h1>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
${MARK}
</td><td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:44px 36px 20px;text-align:center;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">${esc(eyebrow)}</div>
${head}
<div style="font-size:13px;color:#6b6a64;margin-bottom:10px;">${esc(label)}</div>
<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:48px;font-weight:700;color:#0f2c17;letter-spacing:0.12em;line-height:1;padding:20px 0;border-top:1px solid rgba(15,44,23,0.08);border-bottom:1px solid rgba(15,44,23,0.08);margin-bottom:14px;">${esc(code)}</div>
<div style="font-size:12px;color:#6b6a64;">This code expires in ${esc(minutes)} minutes.</div>
</td></tr>
<tr><td style="padding:0 36px 32px;text-align:center;">
<p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:14px 0 18px;">${esc(hint)}</p>
<p style="font-size:12px;color:#6b6a64;line-height:1.5;margin:0;">If you didn't request this, ignore this email. No action will be taken.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>${esc(reason)}</td></tr>
</table></body></html>`;
}
