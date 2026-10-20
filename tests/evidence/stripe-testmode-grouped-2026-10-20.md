# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-20

Run id: `e2e-mvglvh88-1kvan`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-10-20-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-10-20-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "910deaf4-ee55-4ada-b1c7-14e82c500e2e",
  "brand_id": "c70a0fb7-3a92-4444-b5b4-0cc64baecc19",
  "venue_a": "1c1e4153-ee6c-4807-827c-28de2b48bfc4",
  "venue_b": "6bbb054f-5a60-487f-ba08-cd8857e97b92",
  "booking_a": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
  "booking_b": "27adfd83-67c7-441f-bb46-c6e20b346162",
  "checkout_session": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
  "payment_group": "62f4b70c-6e86-4f86-8315-288142792f55",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mvglvhi0-inn5p/?paid=1&bookings=27adfd83-67c7-441f-bb46-c6e20b346162,3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
  "payment_intent": "pi_3USbJQA6b3orPg0T0PtEOXd4",
  "charge": "ch_3USbJQA6b3orPg0T0zsA2LZg",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1USbJRA6b3orPg0TKkReYWUh",
  "evt_pi_succeeded": "evt_3USbJQA6b3orPg0T0rsPrfoW",
  "refund_a": "re_3USbJQA6b3orPg0T0jDaTe6e",
  "refund_request_a": "637bab83-ab3b-4e5f-9319-b5cc77738995",
  "evt_refund_created_a": "evt_3USbJQA6b3orPg0T0cwXRPM3",
  "evt_charge_refunded_a": "evt_3USbJQA6b3orPg0T0uvobxaC",
  "refund_b": "re_3USbJQA6b3orPg0T0A6p2Odz",
  "refund_request_b": "f12d3d43-7afc-4e30-955a-b48875f148b8",
  "evt_refund_created_b": "evt_3USbJQA6b3orPg0T0XOd5OCH",
  "evt_charge_refunded_b": "evt_3USbJQA6b3orPg0T04SZO6Bk"
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

- passed: 88
- failed: 0

## Notes

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261120T210000Z/20261120T230000Z; brand feed = 20261120T210000Z/20261120T230000Z
- route-originated Stripe calls: 5 (writes: /v1/webhook_endpoints/we_1UGuAnA6b3orPg0Tagj0q9RX, /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 7 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
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
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
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
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
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
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
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
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0cwXRPM3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0uvobxaC",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0cwXRPM3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0uvobxaC",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "cancelled_at": "2026-10-20T11:35:04.048+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  },
  {
    "id": "f12d3d43-7afc-4e30-955a-b48875f148b8",
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0cwXRPM3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0uvobxaC",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "cancelled_at": "2026-10-20T11:35:04.048+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  },
  {
    "id": "f12d3d43-7afc-4e30-955a-b48875f148b8",
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0cwXRPM3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0uvobxaC",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0XOd5OCH",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T04SZO6Bk",
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
    "id": "62f4b70c-6e86-4f86-8315-288142792f55",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "stripe_charge_id": "ch_3USbJQA6b3orPg0T0zsA2LZg"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
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
    "id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "cancelled_at": "2026-10-20T11:34:54.875+00:00"
  },
  {
    "id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "cancelled_at": "2026-10-20T11:35:04.048+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "637bab83-ab3b-4e5f-9319-b5cc77738995",
    "booking_id": "3e1a8165-e48f-488a-a8ee-b7d0802b6bfc",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0jDaTe6e",
    "attempts": 0
  },
  {
    "id": "f12d3d43-7afc-4e30-955a-b48875f148b8",
    "booking_id": "27adfd83-67c7-441f-bb46-c6e20b346162",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USbJQA6b3orPg0T0A6p2Odz",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1u76ni7x4ElkVQxp3p1tchYjR8V9txA8LJlcnQBdfI2NpWdPQHJ7KYaDN",
    "stripe_payment_intent_id": "pi_3USbJQA6b3orPg0T0PtEOXd4",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USbJRA6b3orPg0TKkReYWUh",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0rsPrfoW",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0cwXRPM3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0uvobxaC",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T0XOd5OCH",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USbJQA6b3orPg0T04SZO6Bk",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

