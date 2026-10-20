# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-20

Run id: `e2e-mvg3ib3z-f721p`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "adb595e9-5bec-4a4c-ae48-e0be281e3f99",
  "brand_id": "e3c14507-9e0d-4d02-b0f6-6e8ea2aee344",
  "venue_a": "9f0a7ca4-115b-4a7a-8501-d3423e08a6c6",
  "venue_b": "a896efdc-96d5-4956-8999-a1f774fea0cb",
  "booking_a": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
  "booking_b": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
  "checkout_session": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
  "payment_group": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mvg3ibay-jrng0/?paid=1&bookings=06e4c6be-504f-4889-a3a5-7e76f5aa6cab,ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
  "payment_intent": "pi_3USTHuA6b3orPg0T0WuVhJ89",
  "charge": "ch_3USTHuA6b3orPg0T03MZkSZ8",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1USTHvA6b3orPg0T8vuarqvH",
  "evt_pi_succeeded": "evt_3USTHuA6b3orPg0T0FO2HQcE",
  "refund_a": "re_3USTHuA6b3orPg0T0OS7PsbV",
  "refund_request_a": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
  "evt_refund_created_a": "evt_3USTHuA6b3orPg0T0QBiEnWL",
  "evt_charge_refunded_a": "evt_3USTHuA6b3orPg0T0tRt6uR2",
  "refund_b": "re_3USTHuA6b3orPg0T0NCODuhI",
  "refund_request_b": "d453e6fd-7ea2-4484-9a2f-91efabee005e",
  "evt_refund_created_b": "evt_3USTHuA6b3orPg0T0hFph4j9",
  "evt_charge_refunded_b": "evt_3USTHuA6b3orPg0T0hgOlknS"
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
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
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
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
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
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
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
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
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0QBiEnWL",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0tRt6uR2",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0QBiEnWL",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0tRt6uR2",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "cancelled_at": "2026-10-20T03:00:58.862+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  },
  {
    "id": "d453e6fd-7ea2-4484-9a2f-91efabee005e",
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0QBiEnWL",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0tRt6uR2",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "cancelled_at": "2026-10-20T03:00:58.862+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  },
  {
    "id": "d453e6fd-7ea2-4484-9a2f-91efabee005e",
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0QBiEnWL",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0tRt6uR2",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0hFph4j9",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0hgOlknS",
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
    "id": "2371e2ea-a8e0-43a1-adf2-71176516bc8e",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "stripe_charge_id": "ch_3USTHuA6b3orPg0T03MZkSZ8"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
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
    "id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "cancelled_at": "2026-10-20T03:00:48.96+00:00"
  },
  {
    "id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "cancelled_at": "2026-10-20T03:00:58.862+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f26067e4-25fb-4447-a239-8ac93c47ee6c",
    "booking_id": "06e4c6be-504f-4889-a3a5-7e76f5aa6cab",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0OS7PsbV",
    "attempts": 0
  },
  {
    "id": "d453e6fd-7ea2-4484-9a2f-91efabee005e",
    "booking_id": "ee7bf9a3-8355-46b3-bcbc-62d4f9f6eb13",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USTHuA6b3orPg0T0NCODuhI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1b7z57uE4UC1WKjWsRuiXKnz0IP5OJu2MtklccTnyF5SQUOqf5QQ5MbGO",
    "stripe_payment_intent_id": "pi_3USTHuA6b3orPg0T0WuVhJ89",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USTHvA6b3orPg0T8vuarqvH",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0FO2HQcE",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0hFph4j9",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0hgOlknS",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0QBiEnWL",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USTHuA6b3orPg0T0tRt6uR2",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

