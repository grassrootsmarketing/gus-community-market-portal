# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-17

Run id: `e2e-mu5ewssn-doxc0`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-17-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-17-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "251c5617-a26d-4c86-831c-d7e5df6708e4",
  "brand_id": "0b02c4e8-33e9-419b-9f38-2e2afa25f537",
  "venue_a": "e50747ca-3793-4b83-8eca-6b255debfa78",
  "venue_b": "8fe5d6f3-b924-4f63-b093-440140793464",
  "booking_a": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
  "booking_b": "bd38704a-61fb-476d-aa17-4431845709af",
  "checkout_session": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
  "payment_group": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mu5ewsso-t2haw/?paid=1&bookings=b822aef4-2fa7-40c5-9f84-cd40ba4e8b82,bd38704a-61fb-476d-aa17-4431845709af",
  "payment_intent": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
  "charge": "ch_3UGcxTJ9aYEf28il16QEUlj4",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UGcxUJ9aYEf28ilncgscYFs",
  "evt_pi_succeeded": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
  "refund_a": "re_3UGcxTJ9aYEf28il19BOUMPj",
  "refund_request_a": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
  "evt_refund_created_a": "evt_3UGcxTJ9aYEf28il12bCDg80",
  "evt_charge_refunded_a": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
  "refund_b": "re_3UGcxTJ9aYEf28il1aRFgXfw",
  "refund_request_b": "f893794b-5490-4dc1-98fe-627b9b0be46f",
  "evt_refund_created_b": "evt_3UGcxTJ9aYEf28il1DEGfKZX",
  "evt_charge_refunded_b": "evt_3UGcxTJ9aYEf28il1SOKFwzc"
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

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261018T200000Z/20261018T220000Z; brand feed = 20261018T200000Z/20261018T220000Z
- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
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
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
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
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
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
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
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
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il12bCDg80",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il12bCDg80",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "cancelled_at": "2026-09-17T10:54:50.872+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  },
  {
    "id": "f893794b-5490-4dc1-98fe-627b9b0be46f",
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il12bCDg80",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "cancelled_at": "2026-09-17T10:54:50.872+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  },
  {
    "id": "f893794b-5490-4dc1-98fe-627b9b0be46f",
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il12bCDg80",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1DEGfKZX",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1SOKFwzc",
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
    "id": "3bf75b1b-fc21-4deb-9114-280b7bcd0237",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "stripe_charge_id": "ch_3UGcxTJ9aYEf28il16QEUlj4"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
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
    "id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "cancelled_at": "2026-09-17T10:54:43.463+00:00"
  },
  {
    "id": "bd38704a-61fb-476d-aa17-4431845709af",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "cancelled_at": "2026-09-17T10:54:50.872+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "026c1e36-8cfa-48e8-8beb-7d26d53714b8",
    "booking_id": "b822aef4-2fa7-40c5-9f84-cd40ba4e8b82",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il19BOUMPj",
    "attempts": 0
  },
  {
    "id": "f893794b-5490-4dc1-98fe-627b9b0be46f",
    "booking_id": "bd38704a-61fb-476d-aa17-4431845709af",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGcxTJ9aYEf28il1aRFgXfw",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1L2nkA57FKXYthwxy4UplUFoMdfyQuOWM0QP7VKcijZUHwaVyT5M23tL9",
    "stripe_payment_intent_id": "pi_3UGcxTJ9aYEf28il1r3PVoN0",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGcxUJ9aYEf28ilncgscYFs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1Sl6zCgi",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il12bCDg80",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1rRJTZPQ",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1DEGfKZX",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGcxTJ9aYEf28il1SOKFwzc",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

