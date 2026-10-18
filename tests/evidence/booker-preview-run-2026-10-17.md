# Demohub designated booker: paid preview run, evidence log (feeds closure revision 4)

Date: October 17 to 18, 2026 (UTC times below). Preview: https://demohub-booker-preview.vercel.app (CLI deployments of `feat/brand-booker`, bound to demohub-rebuild-check, Stripe test mode, mail sink on, BRAND_INVITE_ENABLED=true on Preview only). Production untouched throughout.

## Setup

- Vercel Git previews are off by design since go-live; this run used `vercel deploy` (Preview target) with a stable alias. Preview SITE_ORIGIN set to the alias by David; Stripe sandbox webhook we_1UGuAnA6b3orPg0Tagj0q9RX repointed to the alias.
- Test brand: Walkthrough Snacks (test), brand ddf24429-e22d-4c34-8fef-1a6004b7ae9c, owner david+walkthrough@demohubhq.com, COI approved to 2027-12-31. Store: Gus's Community Market (TEST) f4f1da68-b23c-481c-b735-e119ed975aa7, venue Gus Main Street (TEST). Sink inbox: david@demohubhq.com.
- One saved product seeded through the app's own validator (p_A_hTuG_Q2d3d, Walkthrough Smoked Serrano Hot Sauce).

## Steps and IDs

1. Designation: owner designated david+booker@demohubhq.com at 00:19:53Z; member 4ea43a37-b7a0-442c-b175-980af24b2693 (pending); invite 03cc6105-2c98-4b56-8229-69c245b89857, delivery_status sent, delivered 00:19:53.992Z to the sink, code not issued until the accept page loaded.
2. Acceptance: accepted_at 00:24:22Z (code entered on /brand/accept).
3. Owner re-agreement: the store's policy hash had changed since the October 3 agreement (default policy text changed October 6), so the booker was refused until the owner agreed again; new agreement 00:47:31Z, old one superseded. The owner also made an owner booking 545d6329 (paid, confirmed) at the same minute, outside the test.
4. Booker booking, first attempt 01:46:38Z: booking e0c02b05-9b0e-4e2e-adc8-e731315af03f created, op_key 12f6025f98b54863a90e4cfc4564dc5c, result stored for replay; the PAGE threw after the answer (finding F3 below) and showed "could not confirm the result". Cancelled by the operator afterwards.
5. Booker booking, after the fix, 01:56:02Z: booking **dcc96017-91d4-448d-89a1-724e7881c8a5**, op_key 58c6a5c6aee948d4bd3810e37be7bd92, booked_by_member_id 4ea43a37…, booked_by_email david+booker@demohubhq.com, demos row 30f9624c-f18a-448b-a9c8-16ebaf8709e9 carries the attribution.
6. Payment: Checkout Session cs_test_a1KtavkdgfNzG8CzR2fcf9BfzlywUsD9jCDDXp3BRFHvDMa6NWLm7N2kwR, PaymentIntent pi_3URjKvA6b3orPg0T1smpLkwp, payment group 56fd5e96-73c2-497c-b99f-9e69a4fde8b8, $30.00, succeeded; webhook delivered to the preview and the booking is paid. Stripe's payer record: customer_details.email = david+booker@demohubhq.com (the booker). Stripe receipt_email = null on the PaymentIntent and the charge, so Stripe sent no receipt of its own (decision 1 exception not triggered in test mode).
7. Confirmation: the test store confirmed on payment (status confirmed at 01:56:36Z, notification_events owner_booking_created + demo_confirmed). No manual store click was needed on the test retailer's configuration.

## Findings fixed during the run (all on `feat/brand-booker`)

- F1 b2e1ff3: booker view's certificate fields (coi_on_file / coi_status / coi_expires) were not read by the booking page or the dashboard band; an approved certificate showed as missing and the client contact gate blocked the booker. Both pages read either naming; contact gate owner-only; booker copy points at the owner.
- F2 1160069: "Designated booker" band on every dashboard tab and the role in the booking page banner (David's request).
- F2b 6b2c72d: booker confirm form prefilled from the booker identity and locked, phone not asked (the server records the brand's contact name and phone and the booker's email).
- F3 28deeef: the BR2-1 sent-record line dereferenced a missing booking code; a committed booking was shown as lost. Regression case 6 in the DOM suite.

## Open design notes from the run (David)

- Payment: BOTH options wanted later: brand's saved card (hidden from the booker) and the booker's own card (built).
- Owner should be able to agree or re-agree to a store's policies from the dashboard (Retailers or Agreements tab), with renewal and policy-change prompts; the booker's dead end should offer "ask the owner".
- Booker should accept Demohub's terms at invitation acceptance and be able to read the store's policies from the booking form.
- Wording: David prefers "designated scheduler" over "booker" in the portal.

8. Revocation: owner revoked the booker at 02:10:34Z (revoked_by_email david+walkthrough@demohubhq.com); member 4ea43a37… status revoked; the used invite stays used. The booker's browser is signed out on its next request (identity refused, session row removed); sessions bound to the member listed below the run.
   Sessions by the booker's email after revocation: none.
9. Cancellation by the store (from the calendar modal's new Cancel demo button): booking dcc96017 cancelled at 02:31:32Z, payment_status refunded, demo row cancelled. Stripe refund re_3URjKvA6b3orPg0T14ud20Oe, $30.00, succeeded at 02:31:31Z, refund_request 554e8be5-1276-42cb-b565-a9717fd0ee82, back to the booker's card (the payer). notification_events demo_cancelled fanned out by a manual worker run: one store-contact delivery accepted. The brand-side cancellation email is sent by booking-action to the owner only (booker revoked, and bookers never receive the payer refund sentence by design); the sink inbox is the record (David to read the intended-recipient line).
   Side exercise: David also cancelled the older owner booking of October 21 (2bf30d20) from the Demos tab: cancelled, refunded, demo cancelled; it exposed F5.

## Findings fixed during the run, continued

- F4 609224a: the store calendar's detail modal was read-only; it now offers Reschedule and Cancel demo under the Demos-tab rules. eb953d8: the confirm dialog's keep button says "Keep demo" (it said "Cancel").
- F5 84a13f1: a cancelled demo stayed on the store calendar grid; cancelled and declined demos now leave the grid (the owner calendar already filtered server-side).

## Result

Every step of closure revision 3 section 4 completed on the preview: designate, accept, book (keyed, attributed), pay (test card, webhook, paid), confirm (store auto-confirm on the test retailer), revoke (sessions gone), cancel (refund to the payer, store notice, owner-only brand notice). Retry-with-the-same-key was exercised by the F3 episode: the first attempt's operation row stored its result for replay. Branch head after the run: 84a13f1.

## Sink inbox (David's reading, 2026-10-17 evening Pacific)

- 7:31 PM: "[SINK] Your Gus's Community Market (TEST) was cancelled (booked by david+booker@demohubhq.com)", intended recipient david+walkthrough@demohubhq.com (owner). No copy to the booker. Brand-side cancellation = owner only, as designed.
- 7:21 PM: "[SINK] Your Gus's Community Market (TEST) was cancelled", intended recipient david+walkthrough@demohubhq.com (the October 21 owner booking).
- 7:32 PM: two store-side "Demo cancelled: Walkthrough Snacks (test) at Gus Main Street (TEST), ..." delivered directly to david@demohubhq.com (store contact, allowlisted).
- Copy finding F6 (open): the owner's cancellation subject reads "Your <store> was cancelled"; should read "Your demo at <store> was cancelled".
- Still to read: the 6:56 PM confirmation and receipt (expected owner).
- Receipt, from the outbox records (no inbox read needed): notification_events payment_receipt for group 56fd5e96 created 01:56:35Z, fanned out 01:59:14Z, ONE delivery, recipient_kind brand, recipient david+walkthrough@demohubhq.com (owner), status accepted. No receipt delivery to the booker.
- Store-side deliveries tonight: demo_confirmed and demo_cancelled to the store contact, owner_booking_created to the Demohub owner, all accepted.

## Built after the run, same night (David's pre-ship asks)

- 165f650: owner agrees or re-agrees to a store's policies from the dashboard (Retailers tab pill + "Review and agree"; Agreements tab button on an expired or out-of-date row, opened by default; header band when a store changed its policies or an agreement expired; signature modal shows the store's CURRENT policies, scroll-to-the-end rule, records through agreement-sign). Booker's dead end: "Email the owner" (prefilled) and "Read the policies" (read-only modal); booker confirm form links to the store's policies. Owner cancellation subject: "Your demo at <store> was cancelled" (F6). agreement-list hash fix (F7, pre-existing: the Agreements tab computed the current policy hash without the terms version, so every agreement showed Re-sign needed).
- 0101 + commit after it: the booker accepts Demohub's Terms of Service on the accept page (required box, names the brand, states that demos are made in the brand's name under its insurance and store agreements); booker_accept records terms_accepted_at and terms_version; refusal without it is 400 terms_required. Kit: 0097-0101-brand-booker-paste.sql + MANIFEST-0097-0101.json; rehearsal 6/6; 0101 applied on demohub-rebuild-check.
- Still open (design, not built): "designated scheduler" wording (David undecided), saved-card payment option (addendum design, Codex review first), expiry reminder emails for store agreements (the band covers the dashboard; mail reminders are a follow-up).

## Which build did what (Codex rev4 item 1): immutable deployment per step

The alias https://demohub-booker-preview.vercel.app moved as fixes landed. Each CLI deployment is immutable; the mapping below is from the deployment logs (UTC) and the server timestamps of each step.

| UTC | Step | Deployment (immutable URL prefix) | Branch SHA deployed |
|---|---|---|---|
| 23:59 (Oct 17) | first preview up | demohub-ilx0c2gzh | 014d9af |
| 00:11 | rebuilt after David set Preview SITE_ORIGIN; designation 00:19:53Z and acceptance 00:24:22Z ran here | demohub-br4v58hxm | 014d9af |
| 00:37 | F1 fix; owner re-agreement 00:47:31Z and the owner's own booking 545d6329 ran here | demohub-6ysp4shxe | b2e1ff3 |
| 01:17 | F2 band | demohub-d1c6fep9k | 1160069 |
| 01:34 | F2b confirm form; the first booker attempt e0c02b05 (01:46:38Z, finding F3) ran here | demohub-d657s7orh | 6b2c72d |
| 01:53 | F3 fix; booker booking dcc96017 (01:56:02Z), payment and webhook (01:56:3xZ, logged on this deployment), revocation 02:10:34Z ran here | demohub-q4pq5feq3 | 28deeef |
| 02:17 | F4 calendar actions; the October 21 cancellation (02:21:40Z, Demos tab) ran here | demohub-6bebfn6kw | 609224a |
| 02:24 | Keep demo | demohub-1e7c9apnx | eb953d8 |
| 02:28 | F5; the cancellation of dcc96017 (02:31:32Z, calendar modal) ran here | demohub-nz73x447j | 84a13f1 |
| 03:03 | N1, N2, F6, F7 | demohub-uhbhlrk1c | 165f650 |
| 03:11 | N3 (0101) | demohub-nndidiv03 | 3f2353b |
| 03:43 | Codex rev4 items 2 and 4 (0102); the scripted journey below ran here | demohub-8inrxazw9, deployment id dpl_3EQg5DKyGwsRPLebV1og6Zh3WWqw | 1f52090 |

## Scripted journey on the final deployment (Codex rev4 item 1), 2026-10-18 03:58Z, 23 of 23

Script: tools/preview-booker-journey.mjs (in the repo). Result: tests/evidence/booker-journey-2026-10-18.json (also Documents/Codex/evidence/). Deployment dpl_3EQg5DKyGwsRPLebV1og6Zh3WWqw, SHA 1f52090, alias row recorded by the script. Sessions for the owner, a new booker (david+booker2@demohubhq.com, member 6eb01a8a) and the store were minted in the test database; the store was set to manual-confirm for the run and restored afterwards.

- Post-fix agreement binding on the deployed route: agreement-check gives the current hash; a stale hash is refused 409 policy_changed without writing; the current hash replays the live agreement (no new row); no hash is 400; the booker is 403. Terms: a wrong terms_version is 409 terms_version_mismatch; no Terms box is 400 terms_required.
- Booking abe77551 (2026-11-04 10:00 AM) with op_key journey_b1ac634183e1ac3ec45120db: the SAME request with the SAME key replayed the same booking (one booking, one operation row, replay flagged, checkout untouched); a changed payload under the same key was 409 op_key_reused; the owner replaying the booker's key was 409.
- Payment through Stripe's real hosted test page by the script (card 4242): session cs_test_a1UEdK3q…, intent pi_3URlF1A6b3orPg0T1tUyC5qa, $30.00; the webhook marked it paid and the booking WAITED as pending for the manual-confirm store.
- The store's confirm action confirmed it; the worker fanned out store notices; no outbox delivery addressed the booker.
- The owner revoked the booker; the booker's replay of the paid booking's key and a fresh booking were both 401; no booker session remained; the paid confirmed booking stayed attributed to the revoked member.
- The store cancelled: booking cancelled, payment refunded, Stripe refund re_3URlF1A6b3orPg0T1flCFRXs $30.00 succeeded on the booker's payment; the cancellation notice reached the store contact; nothing addressed the booker.
