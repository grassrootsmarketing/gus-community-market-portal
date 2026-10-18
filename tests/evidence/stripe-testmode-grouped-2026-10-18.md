# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-18

Run id: `e2e-mve8ypjd-3dz2a`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-10-18-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-10-18-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "2e3c575d-db19-47df-8a05-e5f6b7cbb513",
  "brand_id": "c4a3343d-be4d-4258-8939-5b46441f4407",
  "venue_a": "bb34c7cd-0036-48be-8020-eaf94f972f06",
  "venue_b": "2d5d6369-51a6-4eb9-8394-e5dee4fbd927",
  "booking_a": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
  "booking_b": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
  "checkout_session": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
  "payment_group": "9766457d-297a-44c3-ac60-33d4fefc68ec",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mve8ypjf-cglz3/?paid=1&bookings=6cfe6a86-c368-4bf7-b7de-024cf719c937,6e208437-6a65-4bdd-abf2-2f9f6797d51b",
  "payment_intent": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
  "charge": "ch_3US0D6A6b3orPg0T1Km5TuvZ",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1US0D7A6b3orPg0TztF1B9qi",
  "evt_pi_succeeded": "evt_3US0D6A6b3orPg0T16v5aRWn",
  "refund_a": "re_3US0D6A6b3orPg0T1iOiLQ3d",
  "refund_request_a": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
  "evt_refund_created_a": "evt_3US0D6A6b3orPg0T1q3z76CS",
  "evt_charge_refunded_a": "evt_3US0D6A6b3orPg0T1KMxGykD",
  "refund_b": "re_3US0D6A6b3orPg0T13BHpjwi",
  "refund_request_b": "f57a0278-53a5-448a-8159-dc7f2fa1b1d7",
  "evt_refund_created_b": "evt_3US0D6A6b3orPg0T1EDb09AN",
  "evt_charge_refunded_b": "evt_3US0D6A6b3orPg0T1SDXRgFw"
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

- passed: 86
- failed: 2

**Failures**
- FAIL the webhook retrieved the PaymentIntent from REAL Stripe (GET /v1/payment_intents/{pi}) []
- FAIL post-payment emails were intercepted (never sent) and all routed to the allowlisted sink []

## Notes

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261118T210000Z/20261118T230000Z; brand feed = 20261118T210000Z/20261118T230000Z
- route-originated Stripe calls: 3 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 4 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
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
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
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
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
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
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
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
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1KMxGykD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1q3z76CS",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

### after cancel replay + worker

**payment_groups**
```json
[
  {
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1q3z76CS",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1KMxGykD",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "cancelled_at": "2026-10-18T19:58:01.162+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  },
  {
    "id": "f57a0278-53a5-448a-8159-dc7f2fa1b1d7",
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1q3z76CS",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1KMxGykD",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "cancelled_at": "2026-10-18T19:58:01.162+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  },
  {
    "id": "f57a0278-53a5-448a-8159-dc7f2fa1b1d7",
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1q3z76CS",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1EDb09AN",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1KMxGykD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1SDXRgFw",
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
    "id": "9766457d-297a-44c3-ac60-33d4fefc68ec",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "stripe_charge_id": "ch_3US0D6A6b3orPg0T1Km5TuvZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
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
    "id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "cancelled_at": "2026-10-18T19:57:53.997+00:00"
  },
  {
    "id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "cancelled_at": "2026-10-18T19:58:01.162+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "63b21f5a-efbf-4656-a466-e86bc9826bd9",
    "booking_id": "6cfe6a86-c368-4bf7-b7de-024cf719c937",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T1iOiLQ3d",
    "attempts": 0
  },
  {
    "id": "f57a0278-53a5-448a-8159-dc7f2fa1b1d7",
    "booking_id": "6e208437-6a65-4bdd-abf2-2f9f6797d51b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3US0D6A6b3orPg0T13BHpjwi",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1V1N8cp39gIxXom8nS5cxH7YNJWugftu1sYEUAXaQt0KdYavg7TipBuES",
    "stripe_payment_intent_id": "pi_3US0D6A6b3orPg0T1YyBb5RJ",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1US0D7A6b3orPg0TztF1B9qi",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T16v5aRWn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1EDb09AN",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1KMxGykD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1q3z76CS",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3US0D6A6b3orPg0T1SDXRgFw",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

