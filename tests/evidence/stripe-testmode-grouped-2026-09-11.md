# Stripe TEST-MODE grouped payment + partial refund evidence — 2026-09-11

Run id: `e2e-mtwp6frm-uq2im`. Script: `tests/stripe_testmode_grouped.e2e.mjs` (harness `tests/_route.mjs`, real Stripe test mode, real staging DB `tileejdviuvijumjeplv`, Resend intercepted).

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
  "retailer_id": "fcf77b7a-aed7-4224-8b89-eee6026e2d0f",
  "brand_id": "ceb100a8-1b18-4676-b31f-3d789fc9f192",
  "venue_a": "605d231d-ec36-4be5-b483-9cbee42ae10f",
  "venue_b": "160776d0-ba6f-43aa-8ca8-a0b2a56bb275",
  "booking_a": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
  "booking_b": "ffa41d41-21dc-49c0-bc92-a50272583deb",
  "checkout_session": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
  "payment_group": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
  "success_redirect": "https://staging.demohubhq.test/r/e2e-grp-mtwp6frn-2ugmq/?paid=1&bookings=b128ee54-c216-4b9f-bb6b-e6dd09f86577,ffa41d41-21dc-49c0-bc92-a50272583deb",
  "payment_intent": "pi_3UEPsHJ9aYEf28il0yaTunL3",
  "charge": "ch_3UEPsHJ9aYEf28il0bkWhnpW",
  "card_fingerprint_brand": "visa",
  "evt_checkout_completed": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
  "evt_pi_succeeded": "evt_3UEPsHJ9aYEf28il09fWszl9",
  "refund_a": "re_3UEPsHJ9aYEf28il09sSrAah",
  "refund_request_a": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
  "evt_refund_created_a": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
  "evt_charge_refunded_a": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
  "refund_b": "re_3UEPsHJ9aYEf28il0fDgIjg0",
  "refund_request_b": "8a257676-2a05-4c73-9ad3-dd414beaacf9",
  "evt_refund_created_b": "evt_3UEPsHJ9aYEf28il0rTovPdW",
  "evt_charge_refunded_b": "evt_3UEPsHJ9aYEf28il0WS6w5t2"
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
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
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "pending_payment",
    "payment_status": "unpaid",
    "payment_intent_id": null,
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
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
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "pending",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
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
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "paid",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 0,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
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
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "partially_refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "confirmed",
    "payment_status": "paid",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": null,
    "cancelled_at": null
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "cancelled_at": "2026-09-11T08:32:22.268+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  },
  {
    "id": "8a257676-2a05-4c73-9ad3-dd414beaacf9",
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "cancelled_at": "2026-09-11T08:32:22.268+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  },
  {
    "id": "8a257676-2a05-4c73-9ad3-dd414beaacf9",
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0rTovPdW",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0WS6w5t2",
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
    "id": "5170a617-5cc0-4c22-a31d-7e9870e89f4c",
    "status": "refunded",
    "total_customer_amount": 1600,
    "platform_keeps_all": true,
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "stripe_charge_id": "ch_3UEPsHJ9aYEf28il0bkWhnpW"
  }
]
```

**payment_allocations**
```json
[
  {
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "customer_amount": 700,
    "venue_amount": 700,
    "platform_fee_amount": 0,
    "refunded_amount": 700,
    "reserved_refund_amount": 0
  },
  {
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
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
    "id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "cancelled_at": "2026-09-11T08:32:14.691+00:00"
  },
  {
    "id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "status": "cancelled",
    "payment_status": "refunded",
    "payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "cancelled_at": "2026-09-11T08:32:22.268+00:00"
  }
]
```

**refund_requests**
```json
[
  {
    "id": "eff437ca-b76d-4996-b0d2-229d05cc7ce2",
    "booking_id": "b128ee54-c216-4b9f-bb6b-e6dd09f86577",
    "amount": 700,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il09sSrAah",
    "attempts": 0
  },
  {
    "id": "8a257676-2a05-4c73-9ad3-dd414beaacf9",
    "booking_id": "ffa41d41-21dc-49c0-bc92-a50272583deb",
    "amount": 900,
    "currency": "usd",
    "status": "succeeded",
    "stripe_refund_id": "re_3UEPsHJ9aYEf28il0fDgIjg0",
    "attempts": 0
  }
]
```

**payment_attempts**
```json
[
  {
    "stripe_checkout_session_id": "cs_test_b1McG5KoYYQqJLWGdfLyZje6UmZBJKDmfJeH9Da9lupsN1UeEf9IwdPU2G",
    "stripe_payment_intent_id": "pi_3UEPsHJ9aYEf28il0yaTunL3",
    "status": "paid"
  }
]
```

**processed_stripe_events**
```json
[
  {
    "event_id": "evt_1UEPsIJ9aYEf28ilL7fRhyNL",
    "event_type": "checkout.session.completed",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il09fWszl9",
    "event_type": "payment_intent.succeeded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0b5qHRaA",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0g9TMsgj",
    "event_type": "charge.refunded",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0rTovPdW",
    "event_type": "refund.created",
    "status": "completed"
  },
  {
    "event_id": "evt_3UEPsHJ9aYEf28il0WS6w5t2",
    "event_type": "charge.refunded",
    "status": "completed"
  }
]
```

