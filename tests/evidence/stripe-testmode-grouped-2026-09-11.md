# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-11

Run id: `e2e-mtxl94zj-qow6w`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-11-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-11-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "7e7604de-b826-44a9-9399-6bbaf65ab743",
  "brand_id": "2aa276e8-1e82-4266-ad7d-a62af69dda6a",
  "venue_a": "908d689d-b2fe-4c96-b292-7f7e8fba9126",
  "venue_b": "bb6422c1-0fe2-48b3-a392-6fec60acc32d",
  "booking_a": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
  "booking_b": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
  "checkout_session": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
  "payment_group": "4565b505-474e-44e7-ac1e-abe8af079155",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtxl94zk-2533f/?paid=1&bookings=c891ecba-d48a-40cf-938d-94cdd6b4a3a2,ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
  "payment_intent": "pi_3UEdtGJ9aYEf28il0KQFltxb",
  "charge": "ch_3UEdtGJ9aYEf28il073KtNwx",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
  "evt_pi_succeeded": "evt_3UEdtGJ9aYEf28il0caAPyy8",
  "refund_a": "re_3UEdtGJ9aYEf28il0NCksN2d",
  "refund_request_a": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
  "evt_refund_created_a": "evt_3UEdtGJ9aYEf28il0QOiediq",
  "evt_charge_refunded_a": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
  "refund_b": "re_3UEdtGJ9aYEf28il0CG6RRs8",
  "refund_request_b": "dc8a8178-bbe9-4695-919e-80c1ebc0072c",
  "evt_refund_created_b": "evt_3UEdtGJ9aYEf28il0IuYXxD3",
  "evt_charge_refunded_b": "evt_3UEdtGJ9aYEf28il09zMizGr"
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

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261012T200000Z/20261012T220000Z; brand feed = 20261012T200000Z/20261012T220000Z
- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
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
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
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
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
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
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
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
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0QOiediq",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0QOiediq",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "cancelled_at": "2026-09-11T23:30:21.661+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  },
  {
    "id": "dc8a8178-bbe9-4695-919e-80c1ebc0072c",
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0QOiediq",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "cancelled_at": "2026-09-11T23:30:21.661+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  },
  {
    "id": "dc8a8178-bbe9-4695-919e-80c1ebc0072c",
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0QOiediq",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0IuYXxD3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il09zMizGr",
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
    "id": "4565b505-474e-44e7-ac1e-abe8af079155",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "stripe_charge_id": "ch_3UEdtGJ9aYEf28il073KtNwx"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
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
    "id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "cancelled_at": "2026-09-11T23:30:13.11+00:00"
  },
  {
    "id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "cancelled_at": "2026-09-11T23:30:21.661+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "f6761fb1-78f5-437d-89bb-ebc009c3ad95",
    "booking_id": "c891ecba-d48a-40cf-938d-94cdd6b4a3a2",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0NCksN2d",
    "attempts": 0
  },
  {
    "id": "dc8a8178-bbe9-4695-919e-80c1ebc0072c",
    "booking_id": "ec92f61f-61ce-4cfa-83c9-18270aeebdc3",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEdtGJ9aYEf28il0CG6RRs8",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b14Uzx1DrRcBkpNqMRABwTJlCeUyIxNOWR9nyXEcCV9Qst6dMPxlanv5b6",
    "stripe_payment_intent_id": "pi_3UEdtGJ9aYEf28il0KQFltxb",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEdtIJ9aYEf28il0f3yt1Me",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0caAPyy8",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0QOiediq",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0ZH12jYg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il0IuYXxD3",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEdtGJ9aYEf28il09zMizGr",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

