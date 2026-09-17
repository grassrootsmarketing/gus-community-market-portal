# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-17

Run id: `e2e-mu4xkff1-897pv`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "de22d9ae-3476-483b-abff-1b835a910f0a",
  "brand_id": "2fa15354-9c74-4774-8584-2558ffe006bb",
  "venue_a": "a5fb1332-0135-421d-9303-cf1e94b101ca",
  "venue_b": "76c48255-4288-4fe0-a6e1-3a8c21418328",
  "booking_a": "81b5140b-e025-42b3-865e-f0eff0959b40",
  "booking_b": "167c3272-a289-4c6a-b551-683611b5991b",
  "checkout_session": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
  "payment_group": "12c11182-9330-41fe-b0fb-90b895935b50",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mu4xkff2-ll1ot/?paid=1&bookings=167c3272-a289-4c6a-b551-683611b5991b,81b5140b-e025-42b3-865e-f0eff0959b40",
  "payment_intent": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
  "charge": "ch_3UGVNcJ9aYEf28il0kgGLj68",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UGVNdJ9aYEf28il2rXwirdK",
  "evt_pi_succeeded": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
  "refund_a": "re_3UGVNcJ9aYEf28il0WQup7kI",
  "refund_request_a": "19c7e55f-0914-4665-857b-41884ef31bc5",
  "evt_refund_created_a": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
  "evt_charge_refunded_a": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
  "refund_b": "re_3UGVNcJ9aYEf28il00IcdR65",
  "refund_request_b": "e66eaacd-4fcd-46c0-8427-52786f903989",
  "evt_refund_created_b": "evt_3UGVNcJ9aYEf28il0ouExEma",
  "evt_charge_refunded_b": "evt_3UGVNcJ9aYEf28il0iCYUyiW"
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
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
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
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
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
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
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
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
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "cancelled_at": "2026-09-17T02:49:21.627+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  },
  {
    "id": "e66eaacd-4fcd-46c0-8427-52786f903989",
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "cancelled_at": "2026-09-17T02:49:21.627+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  },
  {
    "id": "e66eaacd-4fcd-46c0-8427-52786f903989",
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0iCYUyiW",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0ouExEma",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
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
    "id": "12c11182-9330-41fe-b0fb-90b895935b50",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "stripe_charge_id": "ch_3UGVNcJ9aYEf28il0kgGLj68"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
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
    "id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "cancelled_at": "2026-09-17T02:49:14.171+00:00"
  },
  {
    "id": "167c3272-a289-4c6a-b551-683611b5991b",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "cancelled_at": "2026-09-17T02:49:21.627+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "19c7e55f-0914-4665-857b-41884ef31bc5",
    "booking_id": "81b5140b-e025-42b3-865e-f0eff0959b40",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il0WQup7kI",
    "attempts": 0
  },
  {
    "id": "e66eaacd-4fcd-46c0-8427-52786f903989",
    "booking_id": "167c3272-a289-4c6a-b551-683611b5991b",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UGVNcJ9aYEf28il00IcdR65",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1NmeGwqkrACUmvMUvj3UOVZ9cWtfaQYyjBbqVzhXlR3aRJWPWPV88EWrA",
    "stripe_payment_intent_id": "pi_3UGVNcJ9aYEf28il0OgVHw8B",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UGVNdJ9aYEf28il2rXwirdK",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0iCYUyiW",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0Ne9hiQw",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0ouExEma",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0RxPa1gH",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UGVNcJ9aYEf28il0YGL1rlT",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

