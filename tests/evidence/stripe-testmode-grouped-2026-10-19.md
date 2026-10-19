# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-10-19

Run id: `e2e-mvf8ib48-4oy7w`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "e106201f-1f51-4a63-b460-7716930d7284",
  "brand_id": "58c5ee1c-a732-46b2-a5d7-c724f955b9fd",
  "venue_a": "cb2fa7b9-04f0-4cfe-ab65-75d26d7ca510",
  "venue_b": "93e63c65-0d03-49f7-ac97-529c18d365ab",
  "booking_a": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
  "booking_b": "5b2433dc-c4d7-481a-8399-e85c83947341",
  "checkout_session": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
  "payment_group": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mvf8ibcd-6hqki/?paid=1&bookings=5b2433dc-c4d7-481a-8399-e85c83947341,bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
  "payment_intent": "pi_3USFk4A6b3orPg0T1kL6PFru",
  "charge": "ch_3USFk4A6b3orPg0T1JZ5BIrt",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
  "evt_pi_succeeded": "evt_3USFk4A6b3orPg0T1ROtUrPk",
  "refund_a": "re_3USFk4A6b3orPg0T1VG54xNt",
  "refund_request_a": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
  "evt_refund_created_a": "evt_3USFk4A6b3orPg0T1IwRZfxj",
  "evt_charge_refunded_a": "evt_3USFk4A6b3orPg0T184PSZzS",
  "refund_b": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
  "refund_request_b": "6e75d8aa-6c3d-41e1-9eaf-fb0bfaea6a19",
  "evt_refund_created_b": "evt_3USFk4A6b3orPg0T1jfuTMuJ",
  "evt_charge_refunded_b": "evt_3USFk4A6b3orPg0T10PZfvhy"
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
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
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
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
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  }
]
```

### after paid-event replay

**payment_groups**
```json
[
  {
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
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
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  }
]
```

### after confirm

**payment_groups**
```json
[
  {
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
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
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  }
]
```

### after cancel A

**payment_groups**
```json
[
  {
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  }
]
```

### after refund-event replay (A)

**payment_groups**
```json
[
  {
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1IwRZfxj",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T184PSZzS",
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1IwRZfxj",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T184PSZzS",
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "cancelled_at": "2026-10-19T12:33:07.544+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  },
  {
    "id": "6e75d8aa-6c3d-41e1-9eaf-fb0bfaea6a19",
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1IwRZfxj",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T184PSZzS",
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "cancelled_at": "2026-10-19T12:33:07.544+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  },
  {
    "id": "6e75d8aa-6c3d-41e1-9eaf-fb0bfaea6a19",
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1IwRZfxj",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T184PSZzS",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1jfuTMuJ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T10PZfvhy",
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
    "id": "4d3f5e5a-4cb6-4b5c-a01e-fe4ce3a06ed0",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "stripe_charge_id": "ch_3USFk4A6b3orPg0T1JZ5BIrt"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
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
    "id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "cancelled_at": "2026-10-19T12:32:59.092+00:00"
  },
  {
    "id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "cancelled_at": "2026-10-19T12:33:07.544+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "3b314e00-9a4a-4be7-9e6c-97f5be12d158",
    "booking_id": "bbf3a0d0-72b2-429c-9f7e-6e3eca462379",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1VG54xNt",
    "attempts": 0
  },
  {
    "id": "6e75d8aa-6c3d-41e1-9eaf-fb0bfaea6a19",
    "booking_id": "5b2433dc-c4d7-481a-8399-e85c83947341",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3USFk4A6b3orPg0T1lL8Z1Eo",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1TMZg0gwtXNYg1QmyrH5DJ2qZIhofPoQT5e8ui2Q8a6ZgY5CJzIFNL81b",
    "stripe_payment_intent_id": "pi_3USFk4A6b3orPg0T1kL6PFru",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3USFk4A6b3orPg0T1ROtUrPk",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_1USFk6A6b3orPg0TjZ6UT8N4",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1IwRZfxj",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T184PSZzS",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T1jfuTMuJ",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3USFk4A6b3orPg0T10PZfvhy",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

