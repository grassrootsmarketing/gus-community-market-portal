# Demohub API route inventory (F5-00 baseline)

18 handler files under `api/`. Classification: **T** = tenant traffic (retailer/brand), **P** =
public/anon, **S** = system op (cron/webhook). All currently authenticate to Postgres with the
service key (the systemic gap the F5 program closes).

| Route | Auth | Class | Notes |
|---|---|---|---|
| admin.js | admin session | T | generic proxy (venues/retailers/contacts/compliance/settings) — being replaced by named commands |
| booking-action.js | admin session | T | confirm/decline/cancel/reschedule + refund |
| coi-status.js | admin session | T | COI waive |
| venues-bulk-import.js | admin session | T | CSV venue import |
| stripe.js | admin session | T | billing/Connect |
| admin-auth.js | admin session + owner allowlist | T + S(owner) | login/team/avatar/policy/owner ops |
| brand-account.js | brand session + cron | T + S(cron) | signup/login/profile/COI/reschedule + COI cron |
| brand-portal.js | — | — | **RETIRED (410)** — legacy company-name cross-read |
| booking.js | none (public) | P | public booking create + agreement-check + COI gate |
| checkout-session.js | none (public) | P | Stripe Checkout create |
| signup.js | none (public) | P | retailer signup — **DISABLED** pending verified flow |
| find-retailer.js | none (public) | P | public-data + status |
| cal.js | token | P | retailer iCal feed (token-gated) |
| stripe-webhook.js | Stripe signature | S | payment/refund/subscription events |
| coi-enforcement.js | cron secret | S | COI reminder/cancel sweep |
| seed-demo.js | cron secret | S | demo tenant seed (non-prod) |
| apply-migrations.js | — | S | **RETIRED (410)** |

**Baseline failing-regression set** (the LG findings that reproduce on this baseline and must be
closed): LG-01 booking/agreement identity, LG-02 passwordless claim, LG-03 public COI, LG-04
calendar=session, LG-05 webhook success-on-failure, LG-06 batch refund fanout, LG-07 refund-fail
closes booking, LG-08 parallel checkout, LG-09 admin stored XSS, LG-11b COI state trust, LG-13
server-side slot capacity.
