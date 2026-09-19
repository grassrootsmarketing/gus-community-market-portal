# Section 3 gate — run 1 (after containment), demohub-prod SQL editor, pasted by David, 2026-09-18T23:35:51Z

| ord | section | item | value |
|---|---|---|---|
| 10 | identity | rows / environment / project_ref | 1 / production / dkgjvsstbgnhcfboqqnd |
| 11 | ledger | versions >= 0060 | 0060,0061,0062,0063,0064,0065,0066,0067,0068,0069,0070,0071,0072 |
| 20–31 | A | open_checkout_attempts, unsettled_groups, authorized_holds, held_bookings, pending_payment_bookings, fulfillments_pending, fulfillments_failed_unresolved, fulfillment_claims_any, refund_requests_in_progress, refund_operations_in_progress, webhook_events_processing_any, payment_uncertainty_open | **all 0** |
| 32 | A | open_reconciliation_cases | 0 |
| 40 | B | T1 used | 2026-09-18 23:16:38+00 |
| 41 | B | heartbeats | daily 14:00:33Z succeeded after_T1=false; provisional-sweep 23:00:23Z succeeded after_T1=false; refund-worker 23:00:09Z succeeded after_T1=false |
| 42–44 | B | fulfilment / event / booking touch after T1 | (none) n/a; 2026-09-05 09:50:26Z false; (none) n/a |
| 45 | B | db_activity_from_app | 0 |
| 50–51 | B2 | events last 3 days; events not completed | (none); (none) |
| 60 | data | retailers / venues / internal_contacts / demos / bookings / brands | 3 / 10 / 33 / 10 / 0 / 0 |
| 99 | meta | taken_at | 2026-09-18 23:35:51Z |

Verdict: every stop-condition clear; identity and history exact; no heartbeat, event, fulfilment or booking touch after T1.
