# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-19

Run id: `e2e-mvfus4ml-bsa4q`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-10-19-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-10-19-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "a6ad4880-b1e4-4212-bb39-f192a243cf36",
  "brand_id": "500a6405-e849-44e9-87c4-565512dd9a33",
  "venue_a": "dafb3630-46ac-4f2a-ab5a-938b17135f0e",
  "venue_b": "8569e2ef-e9a8-42ee-b55e-e6c42e8cd297",
  "booking_a": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
  "booking_b": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
  "checkout_session": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
  "payment_group": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mvfus4tw-dl0i2/?paid=1&bookings=4ce4f3dd-5615-4c6e-a88e-8a5ff78293da,cfeaab62-7967-47a4-a6d8-1043e8af6e23",
  "payment_intent": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
  "charge": "ch_3USPTSA6b3orPg0T08q48r3s",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1USPTTA6b3orPg0T5wf3vUWD",
  "evt_pi_succeeded": "evt_3USPTSA6b3orPg0T0ZyXck32",
  "refund_a": "re_3USPTSA6b3orPg0T0wsXX513",
  "refund_request_a": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
  "evt_refund_created_a": "evt_3USPTSA6b3orPg0T0y2yqRiG",
  "evt_charge_refunded_a": "evt_3USPTSA6b3orPg0T0m4YQVnH",
  "refund_b": "re_3USPTSA6b3orPg0T0H6hKl0P",
  "refund_request_b": "f8f32793-0ea2-4c27-a4fd-eebedd8cd97c",
  "evt_refund_created_b": "evt_3USPTSA6b3orPg0T0CpicRij",
  "evt_charge_refunded_b": "evt_3USPTSA6b3orPg0T0UQ2Mf3q"
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

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261119T210000Z/20261119T230000Z; brand feed = 20261119T210000Z/20261119T230000Z
- route-originated Stripe calls: 5 (writes: /v1/webhook_endpoints/we_1UGuAnA6b3orPg0Tagj0q9RX, /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
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
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
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
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
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
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
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
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0y2yqRiG",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0m4YQVnH",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0y2yqRiG",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0m4YQVnH",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "cancelled_at": "2026-10-19T22:56:38.197+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  },
  {
    "id": "f8f32793-0ea2-4c27-a4fd-eebedd8cd97c",
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0y2yqRiG",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0m4YQVnH",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "cancelled_at": "2026-10-19T22:56:38.197+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  },
  {
    "id": "f8f32793-0ea2-4c27-a4fd-eebedd8cd97c",
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0CpicRij",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0UQ2Mf3q",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0y2yqRiG",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0m4YQVnH",
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
    "id": "59ff2c3f-0c49-45b9-83aa-8948c56c952a",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "stripe_charge_id": "ch_3USPTSA6b3orPg0T08q48r3s"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
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
    "id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "cancelled_at": "2026-10-19T22:56:28.918+00:00"
  },
  {
    "id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "cancelled_at": "2026-10-19T22:56:38.197+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "abf41f00-e77e-46dc-a3b1-2afe3a588a58",
    "booking_id": "4ce4f3dd-5615-4c6e-a88e-8a5ff78293da",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0wsXX513",
    "attempts": 0
  },
  {
    "id": "f8f32793-0ea2-4c27-a4fd-eebedd8cd97c",
    "booking_id": "cfeaab62-7967-47a4-a6d8-1043e8af6e23",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USPTSA6b3orPg0T0H6hKl0P",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1A1blkva9BzJ8AKBRQWBNMRFDzUcDD0q0Eg1MT4bcyGUgqpUVt6UsXPDJ",
    "stripe_payment_intent_id": "pi_3USPTSA6b3orPg0T0yE6U9Uq",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1USPTTA6b3orPg0T5wf3vUWD",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0CpicRij",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0UQ2Mf3q",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0ZyXck32",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0y2yqRiG",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USPTSA6b3orPg0T0m4YQVnH",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

