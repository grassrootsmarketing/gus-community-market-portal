# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-20

Run id: `e2e-mvg71l5v-uiuv9`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "ca56ca57-e1a0-432f-9221-ea74920cfb45",
  "brand_id": "40ac803f-6508-4818-ab63-9312e29324eb",
  "venue_a": "a3366946-1e30-4258-b2dc-37a844c7fc0d",
  "venue_b": "52ddac22-b0a1-48f6-8e3a-acd186815542",
  "booking_a": "f8f95ce8-960c-4567-b75e-43411337eb7e",
  "booking_b": "241f580f-c8ca-4735-a175-6852b9714a0a",
  "checkout_session": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
  "payment_group": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mvg71ldy-19kv7/?paid=1&bookings=241f580f-c8ca-4735-a175-6852b9714a0a,f8f95ce8-960c-4567-b75e-43411337eb7e",
  "payment_intent": "pi_3USUpgA6b3orPg0T15kxFvZ9",
  "charge": "ch_3USUpgA6b3orPg0T1Q1wSE9C",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1USUphA6b3orPg0TdcMXo4bR",
  "evt_pi_succeeded": "evt_3USUpgA6b3orPg0T1dCQbRmh",
  "refund_a": "re_3USUpgA6b3orPg0T1gmDdWwd",
  "refund_request_a": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
  "evt_refund_created_a": "evt_3USUpgA6b3orPg0T1bheKXhF",
  "evt_charge_refunded_a": "evt_3USUpgA6b3orPg0T1FgziTy6",
  "refund_b": "re_3USUpgA6b3orPg0T1jxfkZ3N",
  "refund_request_b": "d5f6b1ba-61aa-407c-bc3c-d887af70a6a2",
  "evt_refund_created_b": "evt_3USUpgA6b3orPg0T1uX38ED3",
  "evt_charge_refunded_b": "evt_3USUpgA6b3orPg0T1F64ThWT"
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
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
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
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
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
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
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
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
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
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1bheKXhF",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1FgziTy6",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1bheKXhF",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1FgziTy6",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "cancelled_at": "2026-10-20T04:39:57.222+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  },
  {
    "id": "d5f6b1ba-61aa-407c-bc3c-d887af70a6a2",
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1bheKXhF",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1FgziTy6",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "cancelled_at": "2026-10-20T04:39:57.222+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  },
  {
    "id": "d5f6b1ba-61aa-407c-bc3c-d887af70a6a2",
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1bheKXhF",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1FgziTy6",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1uX38ED3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1F64ThWT",
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
    "id": "96d9448e-3b63-4c16-a6cf-cbc9c5ebbb6c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "stripe_charge_id": "ch_3USUpgA6b3orPg0T1Q1wSE9C"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
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
    "id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "cancelled_at": "2026-10-20T04:39:47.975+00:00"
  },
  {
    "id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "cancelled_at": "2026-10-20T04:39:57.222+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "4ddf11bc-025d-4c50-b0ba-4c7a298bbd10",
    "booking_id": "f8f95ce8-960c-4567-b75e-43411337eb7e",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1gmDdWwd",
    "attempts": 0
  },
  {
    "id": "d5f6b1ba-61aa-407c-bc3c-d887af70a6a2",
    "booking_id": "241f580f-c8ca-4735-a175-6852b9714a0a",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USUpgA6b3orPg0T1jxfkZ3N",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1WJ9PttOci45aIi7QsKVTkxinujuhIpN4sWWgtG3BxYV6EQnIP88WuJAv",
    "stripe_payment_intent_id": "pi_3USUpgA6b3orPg0T15kxFvZ9",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USUphA6b3orPg0TdcMXo4bR",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1dCQbRmh",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1bheKXhF",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1FgziTy6",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1uX38ED3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USUpgA6b3orPg0T1F64ThWT",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

