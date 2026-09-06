# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-06

Run id: `e2e-mtpm90xl-t8jq3`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-06-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-06-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "9230fa75-4a42-4283-a5e8-f204d98a1329",
  "brand_id": "5b622362-d91c-477c-bd7b-973cb550aa3f",
  "venue_a": "c4faab73-b426-4abb-91ed-c685073d4d4f",
  "venue_b": "258fef48-f131-4c37-b555-6451ef404596",
  "booking_a": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
  "booking_b": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
  "checkout_session": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
  "payment_group": "2481c11a-ce18-4625-90d6-210834b2de45",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtpm90xm-etqik/?paid=1&bookings=8c48cea7-634c-4a42-9a16-f36f4b05e129,f3f0989a-85b2-4d86-b191-a662e38eebd5",
  "payment_intent": "pi_3UCcUEJ9aYEf28il1VixfYyg",
  "charge": "ch_3UCcUEJ9aYEf28il10JxdgqU",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
  "evt_pi_succeeded": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
  "refund_a": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
  "refund_request_a": "e012f700-04b4-4fd3-8958-1246c16fbb99",
  "evt_refund_created_a": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
  "evt_charge_refunded_a": "evt_3UCcUEJ9aYEf28il17yXXSrK",
  "refund_b": "re_3UCcUEJ9aYEf28il19PGNfCb",
  "refund_request_b": "ca0262a0-b311-4cdd-b902-cfafad3118b6",
  "evt_refund_created_b": "evt_3UCcUEJ9aYEf28il1ulaYMQZ",
  "evt_charge_refunded_b": "evt_3UCcUEJ9aYEf28il1GdIZn7Q"
}
```

## Amounts (cents)

```json
{
  "total_cents": 1600,
  "alloc_a": 700,
  "alloc_b": 900,
  "amount_received": 1600,
  "refund_a": 700,
  "refund_b": 900
}
```

## Assertions

- passed: 84
- failed: 0

## Notes

- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "session_created",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": null,
    "stripe_charge_id": null
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
_none_

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": null,
    "status": "open"
  }
]
```

**processed_stripe_events**
_none_

### after payment webhooks

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
_none_

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after paid-event replay

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
_none_

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after confirm

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
_none_

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after cancel A

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after refund-event replay (A)

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17yXXSrK",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

### after cancel replay + worker

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17yXXSrK",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

### after cancel B

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 900,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "cancelled_at": "2026-09-06T09:36:06.455+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  },
  {
    "id": "ca0262a0-b311-4cdd-b902-cfafad3118b6",
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17yXXSrK",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

### after refund-event replay (B)

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 900,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "cancelled_at": "2026-09-06T09:36:06.455+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  },
  {
    "id": "ca0262a0-b311-4cdd-b902-cfafad3118b6",
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17yXXSrK",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1ulaYMQZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1GdIZn7Q",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

### final

**payment_groups**
```json
[
  {
    "id": "2481c11a-ce18-4625-90d6-210834b2de45",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "stripe_charge_id": "ch_3UCcUEJ9aYEf28il10JxdgqU"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "customer_amount": 900,
    "venue_amount": 900,
    "platform_fee_amount": 0,
    "refunded_amount": 900,
    "reserved_refund_amount": 0
  }
]
```

**bookings** (identity columns only)
```json
[
  {
    "id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "cancelled_at": "2026-09-06T09:35:58.308+00:00"
  },
  {
    "id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "cancelled_at": "2026-09-06T09:36:06.455+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "e012f700-04b4-4fd3-8958-1246c16fbb99",
    "booking_id": "f3f0989a-85b2-4d86-b191-a662e38eebd5",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il1Wa7dWEd",
    "attempts": 0
  },
  {
    "id": "ca0262a0-b311-4cdd-b902-cfafad3118b6",
    "booking_id": "8c48cea7-634c-4a42-9a16-f36f4b05e129",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UCcUEJ9aYEf28il19PGNfCb",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1zN6tDjFSEDmQAhlWhHkYvBTzoyOvz6OatAOtxcXKInGRMQb912ui9xcv",
    "stripe_payment_intent_id": "pi_3UCcUEJ9aYEf28il1VixfYyg",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UCcUGJ9aYEf28ilGSAYzWzZ",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1EDUgDTl",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17PPyDIZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il17yXXSrK",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1ulaYMQZ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UCcUEJ9aYEf28il1GdIZn7Q",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

