# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-18

Run id: `e2e-mu685cz8-r3977`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

## Flow driven (all via the shipped route handlers, in-process)

1. Fixtures: keeps-all retailer (`platform_keeps_all=true`, `auto_confirm_bookings=false`, default `cancellation_mode`), venue A \$7 + venue B \$9, approved-COI brand; sessions minted via `brand-account.js` verify and `admin-auth.js` verify (cookies only).
2. `POST /api/book` x2 (brand cookie) -> two `pending_payment` bookings.
3. `POST /api/checkout` with `booking_ids:[A,B]` -> `checkout_claim_group` -> ONE real Checkout Session.
4. Playwright pays on Stripe's hosted page (4242 4242 4242 4242, 12/34, 123, 94110). Screenshots: `stripe-testmode-grouped-2026-09-18-checkout-form.png` (filled hosted page before submit), `stripe-testmode-grouped-2026-09-18-checkout-paid.png` (the success_url Stripe redirected to, rendered by the harness because the harness origin does not resolve).
5. The REAL `checkout.session.completed` + `payment_intent.succeeded` events are fetched from `GET /v1/events` and POSTed to `/api/stripe-webhook` with a correct `Stripe-Signature` (t=…,v1=HMAC-SHA256(`whsec_harness_e2e`)). Wrong-secret and unsigned copies are refused.
6. `POST /api/booking-action {action:'confirm'}` x2 (retailer cookie).
7. `POST /api/booking-action {booking_id:A, action:'cancel'}` (exact payload the shipped admin UI sends) -> `refund_reserve_cas` -> real `POST /v1/refunds` -> `apply_refund_event`.
8. Real `refund.created` + `charge.refunded` replayed (signed); cancel replayed; `refund-worker` run with CRON_SECRET.
9. Cancel B the same way; then over-refund probes (cancel/decline again, direct `refund_reserve_cas`, direct 1-cent Stripe refund).

## Safe identifiers

```json
{
  "retailer_id": "fdaeb169-8862-42d6-99d7-a8994dc5818a",
  "brand_id": "3b2464f1-d72b-4214-a652-bc7f1b556bba",
  "venue_a": "40faca3c-ae42-4964-b24a-1bb3d6b03fab",
  "venue_b": "f4101d95-12e3-4b06-8546-358527ccde02",
  "booking_a": "79522b24-a048-487f-8084-f31a4e074f80",
  "booking_b": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
  "checkout_session": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
  "payment_group": "cbde37db-adb0-4b7a-8730-784c910d9243",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mu685cz9-h7t7c/?paid=1&bookings=79522b24-a048-487f-8084-f31a4e074f80,9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
  "payment_intent": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
  "charge": "ch_3UGpjbA6b3orPg0T1pQgZtTE",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UGpjcA6b3orPg0TLZSp05ey",
  "evt_pi_succeeded": "evt_3UGpjbA6b3orPg0T16GbvmZV",
  "refund_a": "re_3UGpjbA6b3orPg0T1pPo7jbt",
  "refund_request_a": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
  "evt_refund_created_a": "evt_3UGpjbA6b3orPg0T1murNqvw",
  "evt_charge_refunded_a": "evt_3UGpjbA6b3orPg0T19s8nRgD",
  "refund_b": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
  "refund_request_b": "18fc4ec1-04b1-490c-ba5e-d7522f612b20",
  "evt_refund_created_b": "evt_3UGpjbA6b3orPg0T1ozqq3DY",
  "evt_charge_refunded_b": "evt_3UGpjbA6b3orPg0T14R7ajH7"
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

- custom-duration: A 1h (hourly venue), B 2h (custom slots); retailer feed DTSTART/DTEND for B = 20261019T200000Z/20261019T220000Z; brand feed = 20261019T200000Z/20261019T220000Z
- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
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
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
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
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
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
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
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
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1murNqvw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T19s8nRgD",
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
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T19s8nRgD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1murNqvw",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

### after cancel B

**payment_groups**
```json
[
  {
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "cancelled_at": "2026-09-18T00:33:33.717+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  },
  {
    "id": "18fc4ec1-04b1-490c-ba5e-d7522f612b20",
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T19s8nRgD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1murNqvw",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

### after refund-event replay (B)

**payment_groups**
```json
[
  {
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "cancelled_at": "2026-09-18T00:33:33.717+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  },
  {
    "id": "18fc4ec1-04b1-490c-ba5e-d7522f612b20",
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T14R7ajH7",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T19s8nRgD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1murNqvw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1ozqq3DY",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

### final

**payment_groups**
```json
[
  {
    "id": "cbde37db-adb0-4b7a-8730-784c910d9243",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "stripe_charge_id": "ch_3UGpjbA6b3orPg0T1pQgZtTE"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
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
    "id": "79522b24-a048-487f-8084-f31a4e074f80",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "cancelled_at": "2026-09-18T00:33:26.314+00:00"
  },
  {
    "id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "cancelled_at": "2026-09-18T00:33:33.717+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "2b0d13ec-a908-4a85-8c5f-13fed9c4ed07",
    "booking_id": "79522b24-a048-487f-8084-f31a4e074f80",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1pPo7jbt",
    "attempts": 0
  },
  {
    "id": "18fc4ec1-04b1-490c-ba5e-d7522f612b20",
    "booking_id": "9c9f2425-ef46-40d4-be3f-8c28a9fecbc5",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGpjbA6b3orPg0T1JDUmQ0g",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1kxXkXavrd11EN1gaZ9WZZNu37M4ickKPwCRMZS0VKtqRgrmrHsu5cGNx",
    "stripe_payment_intent_id": "pi_3UGpjbA6b3orPg0T1hk5ZMbz",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGpjcA6b3orPg0TLZSp05ey",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T14R7ajH7",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T16GbvmZV",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T19s8nRgD",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1murNqvw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGpjbA6b3orPg0T1ozqq3DY",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

