# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-04

Run id: `e2e-mtmjcfrn-pinpz`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-04-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-04-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "7c2e04a6-dd53-461a-933f-8c6237c16442",
  "brand_id": "79477e83-f6a8-4eac-b56b-fe0097eae62c",
  "venue_a": "80f23216-55c0-403a-80b5-300b633a7cb2",
  "venue_b": "39f67697-cf07-42ba-8751-5e524ec0f476",
  "booking_a": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
  "booking_b": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
  "checkout_session": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
  "payment_group": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtmjcfro-zwxvp/?paid=1&bookings=0cd2c31f-1d62-48a9-9e72-a852a5597dfb,75e6e2d2-a074-4faf-a4d4-32009077ca9f",
  "payment_intent": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
  "charge": "ch_3UBq1gJ9aYEf28il1AzafrCs",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
  "evt_pi_succeeded": "evt_3UBq1gJ9aYEf28il1axZNsqp",
  "refund_a": "re_3UBq1gJ9aYEf28il1lDSrcea",
  "refund_request_a": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
  "evt_refund_created_a": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
  "evt_charge_refunded_a": "evt_3UBq1gJ9aYEf28il1bX36b60",
  "refund_b": "re_3UBq1gJ9aYEf28il1D1fj1or",
  "refund_request_b": "58145b6c-3572-41c7-bfc7-356bf71eaf0c",
  "evt_refund_created_b": "evt_3UBq1gJ9aYEf28il1o8UUwVn",
  "evt_charge_refunded_b": "evt_3UBq1gJ9aYEf28il1vuVw4DX"
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
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
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
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
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
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
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
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
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1bX36b60",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1bX36b60",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "cancelled_at": "2026-09-04T05:51:24.548+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  },
  {
    "id": "58145b6c-3572-41c7-bfc7-356bf71eaf0c",
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1bX36b60",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "cancelled_at": "2026-09-04T05:51:24.548+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  },
  {
    "id": "58145b6c-3572-41c7-bfc7-356bf71eaf0c",
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1bX36b60",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1o8UUwVn",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1vuVw4DX",
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
    "id": "e547c156-a7ae-4ae2-9533-e8b613f4ac8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "stripe_charge_id": "ch_3UBq1gJ9aYEf28il1AzafrCs"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
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
    "id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "cancelled_at": "2026-09-04T05:51:16.804+00:00"
  },
  {
    "id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "cancelled_at": "2026-09-04T05:51:24.548+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "d5efcdfe-3c47-40de-b8ec-b7abb675c6fe",
    "booking_id": "0cd2c31f-1d62-48a9-9e72-a852a5597dfb",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1lDSrcea",
    "attempts": 0
  },
  {
    "id": "58145b6c-3572-41c7-bfc7-356bf71eaf0c",
    "booking_id": "75e6e2d2-a074-4faf-a4d4-32009077ca9f",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UBq1gJ9aYEf28il1D1fj1or",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1aByg97f34aDtKUPdi2DYYE6YXGEKujLciD7Fz2HdP1051eVIrNNev5lU",
    "stripe_payment_intent_id": "pi_3UBq1gJ9aYEf28il1XCcyy4g",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UBq1iJ9aYEf28ill0qsmsqF",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1axZNsqp",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il15Zq1sNA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1bX36b60",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1o8UUwVn",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UBq1gJ9aYEf28il1vuVw4DX",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

