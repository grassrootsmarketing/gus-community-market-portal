# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-12

Run id: `e2e-mty4kz01-x4131`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-12-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-12-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "333c8900-124d-4a35-af93-30250d246e9d",
  "brand_id": "db238dfe-4621-46ee-a6ca-72de2fbfbb2f",
  "venue_a": "a77c25cc-526b-4203-bcc4-bc0042b89312",
  "venue_b": "d8c49804-679c-46f0-a1e8-9bec2866b505",
  "booking_a": "875d6048-b3c8-4984-8078-d27e5f07ca77",
  "booking_b": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
  "checkout_session": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
  "payment_group": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mty4kz04-xx7j5/?paid=1&bookings=1280703d-3365-4dc1-8dc0-e5c8f0c782ec,875d6048-b3c8-4984-8078-d27e5f07ca77",
  "payment_intent": "pi_3UEmKtJ9aYEf28il1EqovYGs",
  "charge": "ch_3UEmKtJ9aYEf28il1JKQGDxJ",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
  "evt_pi_succeeded": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
  "refund_a": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
  "refund_request_a": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
  "evt_refund_created_a": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
  "evt_charge_refunded_a": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
  "refund_b": "re_3UEmKtJ9aYEf28il1bP39Iwr",
  "refund_request_b": "42dc7374-c7e6-4900-ad9a-14a5ebc6d9c9",
  "evt_refund_created_b": "evt_3UEmKtJ9aYEf28il1f2YlHWn",
  "evt_charge_refunded_b": "evt_3UEmKtJ9aYEf28il1k3ZKzgj"
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

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261013T200000Z/20261013T220000Z; brand feed = 20261013T200000Z/20261013T220000Z
- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
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
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
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
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
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
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
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
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "cancelled_at": "2026-09-12T08:31:24.236+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  },
  {
    "id": "42dc7374-c7e6-4900-ad9a-14a5ebc6d9c9",
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "cancelled_at": "2026-09-12T08:31:24.236+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  },
  {
    "id": "42dc7374-c7e6-4900-ad9a-14a5ebc6d9c9",
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1f2YlHWn",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1k3ZKzgj",
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
    "id": "1ac8b8fa-2f13-477a-bd8b-e5de59acdbac",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "stripe_charge_id": "ch_3UEmKtJ9aYEf28il1JKQGDxJ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
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
    "id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "cancelled_at": "2026-09-12T08:31:16.778+00:00"
  },
  {
    "id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "cancelled_at": "2026-09-12T08:31:24.236+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "b1b7d8fc-827f-4116-9fbc-69bbb4a75349",
    "booking_id": "875d6048-b3c8-4984-8078-d27e5f07ca77",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1fo6k3Ka",
    "attempts": 0
  },
  {
    "id": "42dc7374-c7e6-4900-ad9a-14a5ebc6d9c9",
    "booking_id": "1280703d-3365-4dc1-8dc0-e5c8f0c782ec",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEmKtJ9aYEf28il1bP39Iwr",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Djmba7yFWnXErdKTzbEvYsL4pDw6kfPvXAVj53fZ6ir0UNUuuNMBKV7i",
    "stripe_payment_intent_id": "pi_3UEmKtJ9aYEf28il1EqovYGs",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEmKuJ9aYEf28ilxcZkPbyy",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1bo7P7rn",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1s4tMHpi",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1JH6Zzdg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1f2YlHWn",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEmKtJ9aYEf28il1k3ZKzgj",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

