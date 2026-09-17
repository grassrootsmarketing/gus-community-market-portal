# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-12

Run id: `e2e-mtythuwx-b25jj`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "42871b9c-548d-42ed-862f-f2dc8eb40e24",
  "brand_id": "fef354c2-1dea-4b02-b6ed-24a3ff39f07a",
  "venue_a": "5283e6b5-c855-4f37-ae5e-023e83afc038",
  "venue_b": "c9eb6caa-fb6c-44f1-8d6a-71cbd2ab685f",
  "booking_a": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
  "booking_b": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
  "checkout_session": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
  "payment_group": "886012fb-3cc7-4373-b4c9-5077613cca67",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtythuwy-ks9qi/?paid=1&bookings=7871afdd-c423-4351-9492-a7dd8fa9cdcc,a0045d98-68b0-4df8-a21d-bc8a712eebe7",
  "payment_intent": "pi_3UExDlJ9aYEf28il18424iIV",
  "charge": "ch_3UExDlJ9aYEf28il16oT9BwK",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UExDmJ9aYEf28ill6VF7nwO",
  "evt_pi_succeeded": "evt_3UExDlJ9aYEf28il1SY3nJGN",
  "refund_a": "re_3UExDlJ9aYEf28il1Z9gjVvB",
  "refund_request_a": "011cf130-f09f-47df-a60e-d11db9ae2f63",
  "evt_refund_created_a": "evt_3UExDlJ9aYEf28il1YVid9uc",
  "evt_charge_refunded_a": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
  "refund_b": "re_3UExDlJ9aYEf28il1W5V33ay",
  "refund_request_b": "94f40900-2ee7-4982-88b9-ffeb0387bce5",
  "evt_refund_created_b": "evt_3UExDlJ9aYEf28il1CQYDfO6",
  "evt_charge_refunded_b": "evt_3UExDlJ9aYEf28il17NMAv2G"
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
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
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
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
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
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
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
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
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1YVid9uc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1YVid9uc",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "cancelled_at": "2026-09-12T20:08:45.418+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  },
  {
    "id": "94f40900-2ee7-4982-88b9-ffeb0387bce5",
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1YVid9uc",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "cancelled_at": "2026-09-12T20:08:45.418+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  },
  {
    "id": "94f40900-2ee7-4982-88b9-ffeb0387bce5",
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il17NMAv2G",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1CQYDfO6",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1YVid9uc",
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
    "id": "886012fb-3cc7-4373-b4c9-5077613cca67",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "stripe_charge_id": "ch_3UExDlJ9aYEf28il16oT9BwK"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
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
    "id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "cancelled_at": "2026-09-12T20:08:37.927+00:00"
  },
  {
    "id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "cancelled_at": "2026-09-12T20:08:45.418+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "011cf130-f09f-47df-a60e-d11db9ae2f63",
    "booking_id": "a0045d98-68b0-4df8-a21d-bc8a712eebe7",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1Z9gjVvB",
    "attempts": 0
  },
  {
    "id": "94f40900-2ee7-4982-88b9-ffeb0387bce5",
    "booking_id": "7871afdd-c423-4351-9492-a7dd8fa9cdcc",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UExDlJ9aYEf28il1W5V33ay",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1uJbk67tU5L7E4pFtaRPFem6rWLX1r1cfnqFAR1IOPpx3XmoOFLWbWf7r",
    "stripe_payment_intent_id": "pi_3UExDlJ9aYEf28il18424iIV",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UExDmJ9aYEf28ill6VF7nwO",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il17NMAv2G",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1CQYDfO6",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1Q9O4Yen",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1SY3nJGN",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UExDlJ9aYEf28il1YVid9uc",
    "event_type": "refund.created",
    "status": "completed"
  }
]
```

