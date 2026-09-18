# W2 — mail containment: received sink messages in the operator's allowlisted mailbox (2026-09-18)

Evidence: `2026-09-18-sink-inbox-operator-mailbox.png` — David's screenshot of the inbox of the FIRST `EMAIL_ALLOWLIST` entry (his personal Gmail), which is the address the Preview binding uses as the sink.

What it shows (every row: sender "Demohub", subject prefixed `[SINK]`, body preview starting "Non-production email. Intended recipient: <address> — redirected here because that address is not on this environment's allowlist"):

| Subject | Intended recipient (as rewritten by the sink) | Journey step it correlates to |
|---|---|---|
| Your slot is held — upload your COI within 24 hours | `davidmichaelheiser+pvb-mu7gjqa5-15fi@gmail.com` | **real-browser journey, run 1** (2026-09-18T21:16Z = 2:16 PM Pacific): the hold notice frozen in `booking_fulfillments.outbound` for that booking carried exactly this intended address |
| Your 24-hour hold expired — you were not charged | same plus-address | the same journey's cleanup (authorization cancelled at Stripe → Stripe's cancel webhook → release notice) |
| Your demo booking at PVJ manual Retailer / Your PVJ manual Retailer is confirmed / Update on your PVJ manual Retailer request | `pvj-brand-manual-…@example.com`, `pvj-brand-release-…@example.com` | HTTP journey: manual capture, release |
| Your demo booking at PVJ auto Retailer | `pvj-brand-auto-…@example.com` | HTTP journey: automatic capture |
| Your Certificate of Insurance is approved — valid through … | `pvj-brand-manual-…@example.com` | HTTP journey: owner COI approval |
| Demo confirmed: PVJ manual Brand at PVJ manual Venue ($5) / Demo confirmed: PVJ auto Brand at PVJ auto Venue ($5) | `store-pvj-manual-…@example.com`, `store-pvj-auto-…@example.com` | store-contact notifications (notification worker) |

Conclusions, stated at their actual level:
- **Actual recipient = the allowlisted operator mailbox**, for brand mail, owner/COI mail and store-contact notifications alike; intended third-party addresses (`example.com` fixtures and a non-allowlisted plus-address) received nothing — they were rewritten, and the rewrite is visible in each message.
- This is **confirmed delivery to the sink**, not merely provider acceptance.
- Nothing arrived at `david@demohubhq.com` (second allowlist entry) — expected: the sink is the first entry only.
- Not shown: cc/bcc headers of an opened message (the code path sends none; `api/_mail.js` builds `to` only).
- The Gmail connector available to Claude is attached to a different mailbox, which is why Claude's earlier searches found nothing; that was a tooling limitation, not a delivery failure.
