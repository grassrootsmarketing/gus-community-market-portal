# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-11

Run id: `e2e-mtwm52hr-xd7cj`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "a48fcd42-8123-448c-9139-81b42ffaa665",
  "brand_id": "02e32f90-55c4-4f2d-8ba0-bb0ea70f799b",
  "venue_a": "8eedea05-67dd-487d-816d-6400f9b4a15f",
  "venue_b": "8412b753-1df8-4b21-9919-76b7a1dde4e3",
  "booking_a": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
  "booking_b": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
  "checkout_session": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
  "payment_group": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtwm52hs-vtofy/?paid=1&bookings=7b403c1e-9a47-4eab-b63c-e2bc3a57276d,a1affa43-d0d5-4354-abfe-61ed8805fc1c",
  "payment_intent": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
  "charge": "ch_3UEOY5J9aYEf28il1tC4PAtZ",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UEOY6J9aYEf28ilqKrHimqs",
  "evt_pi_succeeded": "evt_3UEOY5J9aYEf28il1wNxsGQa",
  "refund_a": "re_3UEOY5J9aYEf28il1P8AATYe",
  "refund_request_a": "1e9d287a-4847-4c58-937c-c1daf200e85f",
  "evt_refund_created_a": "evt_3UEOY5J9aYEf28il1TCmjjxc",
  "evt_charge_refunded_a": "evt_3UEOY5J9aYEf28il1yaISVCg",
  "refund_b": "re_3UEOY5J9aYEf28il1NusH9Lg",
  "refund_request_b": "ab1adec5-4d03-4ef4-b93c-7c7628d955a4",
  "evt_refund_created_b": "evt_3UEOY5J9aYEf28il1LPcdOY5",
  "evt_charge_refunded_b": "evt_3UEOY5J9aYEf28il10b44F9F"
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

- passed: 87
- failed: 0

## Notes

- custom-duration: A 1h (hourly venue), B 2h (custom slots); feed DTSTART/DTEND for B = 20261012T200000Z/20261012T220000Z
- route-originated Stripe calls: 4 (writes: /v1/checkout/sessions, /v1/refunds, /v1/refunds)
- intercepted Resend sends: 6 (every recipient rewritten to the allowlisted sink; nothing left the machine)

## Redacted DB rows (before / after)

### before payment

**payment_groups**
```json
[
  {
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
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
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
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
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
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
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
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
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3UEOY5J9aYEf28il1TCmjjxc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1yaISVCg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after cancel replay + worker

**payment_groups**
```json
[
  {
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3UEOY5J9aYEf28il1TCmjjxc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1yaISVCg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after cancel B

**payment_groups**
```json
[
  {
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "cancelled_at": "2026-09-11T07:07:25.316+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  },
  {
    "id": "ab1adec5-4d03-4ef4-b93c-7c7628d955a4",
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3UEOY5J9aYEf28il1TCmjjxc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1yaISVCg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  }
]
```

### after refund-event replay (B)

**payment_groups**
```json
[
  {
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "cancelled_at": "2026-09-11T07:07:25.316+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  },
  {
    "id": "ab1adec5-4d03-4ef4-b93c-7c7628d955a4",
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3UEOY5J9aYEf28il1TCmjjxc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1yaISVCg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1LPcdOY5",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il10b44F9F",
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
    "id": "15fa6d75-7aa9-48ce-8ee6-407d31db715c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "stripe_charge_id": "ch_3UEOY5J9aYEf28il1tC4PAtZ"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
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
    "id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "cancelled_at": "2026-09-11T07:07:17.527+00:00"
  },
  {
    "id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "cancelled_at": "2026-09-11T07:07:25.316+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "1e9d287a-4847-4c58-937c-c1daf200e85f",
    "booking_id": "7b403c1e-9a47-4eab-b63c-e2bc3a57276d",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1P8AATYe",
    "attempts": 0
  },
  {
    "id": "ab1adec5-4d03-4ef4-b93c-7c7628d955a4",
    "booking_id": "a1affa43-d0d5-4354-abfe-61ed8805fc1c",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEOY5J9aYEf28il1NusH9Lg",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1Zn48VJNUYQwWl44HxCxwx9eWg3CxU9zD3SxenEMX8mMiHsSsmtSiEUTp",
    "stripe_payment_intent_id": "pi_3UEOY5J9aYEf28il1T8Qx0fY",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_3UEOY5J9aYEf28il1TCmjjxc",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1yaISVCg",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_1UEOY6J9aYEf28ilqKrHimqs",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1wNxsGQa",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il1LPcdOY5",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEOY5J9aYEf28il10b44F9F",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

