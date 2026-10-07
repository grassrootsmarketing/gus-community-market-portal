# Demo policy: notes from other retailers' documents

Running file. Each entry compares a retailer's own vendor-demo document against Demohub's standard Layer-1 Guidelines (the click-accept text live on Gus's `demo_policy`, 6,842 chars, structure settled 2026-08-22) and records what is worth adopting in the standard, what is store-specific (ignored), and what conflicts with our liability spine (not adopted). The live text is not changed by this file; changes to the standard are a deliberate step because the accepted text is hashed into each brand's agreement.

## 2026-10-03: "Vendor Demo Scheduling Process at CM Preston" (one page, Central Market / H-E-B store)

Source: `Downloads/Vendor Demo Scheduling Process (1).pdf` (copied to `Documents/Codex/demo-policy-sources/`).

### Worth adding to the standard (general, not chain-specific)

1. **Shelf stock on demo day.** Theirs: the vendor must make sure the product has been ordered and there is ample product for customers to buy on the day, by contacting the department manager ahead; store staff help set up but do not order product for specific dates. Ours has nothing on this. It is the single most common reason a demo is wasted. Proposed bullet under BEFORE YOUR DEMO: "Confirm with the store's buyer or department manager, well before your date, that your product is stocked and there is enough on the shelf for customers to buy during the demo. The store does not order product for a demo date unless it tells you so in writing." Product idea (separate): a booking-form checkbox "I have confirmed shelf stock for this date" or a reminder line in the confirmation email.
2. **Minimum age.** Theirs: representatives must be 18 or older. Ours states no minimum (the alcohol section says "of-age approved server" only). Proposed, under BEFORE YOUR DEMO or CONDUCT: "Demo personnel must be at least 18 years old (21 for any approved alcohol demo)."
3. **Dress code specifics.** Theirs: closed-toe shoes, long pants (no shorts), clean company-logo or plain shirt; no ripped jeans or workout attire. Ours: "Dress professionally and wear your own brand identification." Closed-toe shoes is a safety item worth naming. Proposed: "Dress professionally: closed-toe shoes, long pants, and a clean brand or plain shirt."
4. **Visible identification.** Theirs: a badge with the rep's name and company so customers know who is serving them. Ours: "wear your own brand identification." Proposed sharpening: "Wear visible identification showing your name and your brand or employer, so customers know who is serving them."

### Optional, retailer-configurable (not in the default, offered as a line a store can switch on)

5. **Presentation standard.** Theirs: products should be used as an ingredient in a recipe or presented "in an elevated manner"; opening a package and serving it is not a demo; certain stand-alone items (chips, salsa, teas, soda water) are no longer allowed. This is a brand-experience standard, and strict. Our text already binds the brand to the preparation method approved at booking. Proposed optional line: "The store may require that products be prepared or presented in a particular way (for example as part of a recipe). A demo should be an engaging tasting, not only opening a package and handing out a sample." Gus has not asked for this; keep it out of the default unless he wants it.

### Operational intake, not policy text

6. **Equipment list.** Theirs asks for "equipment needed" up front (that store provides all equipment). Our booking form captures electricity only. A free-text "equipment you will bring or need" field at booking would help any store; this is a product follow-up, not a Guidelines change.

### Store-specific, ignored

- Scheduling by email to a store address (Demohub is the booking channel).
- Demo hours noon to 6 pm.
- "Store provides all equipment" (ours: bring your own supplies; a store can edit its own policy text).
- Sign-in location (Receiving) and the store's badge.

### Not adopted (conflicts with the liability spine)

- "The store's team will discuss food safety and provide you with guidelines." Our Guidelines deliberately make food safety the brand's own responsibility and keep store review administrative only; a store undertaking to provide food-safety guidance is what counsel told us to avoid. Keep ours.

### If adopted

Items 1 to 4 add roughly 90 words to the Layer-1 text. Applying them means: update the default text (`DEFAULT_DEMO_POLICY` is the short legacy fallback in `api/booking.js`; Gus's live text lives in `retailers.demo_policy`), re-save Gus's policy from the admin, and know that brands who already accepted keep their accepted snapshot (new bookings accept the new text). The Layer-2 master (v3, counsel review pending) already covers age/minors and identification in more formal language; no change needed there for these items.

### Applied 2026-10-07
Items 1 to 4 plus a fifth (food handler's card or permit, valid in the state where the demo takes place, carried at the demo and shown on request) are LIVE on Gus's `demo_policy` (David's SQL paste; verified from the public booking data: all five present, zero em dashes, text identical to `Documents/Codex/Demohub-Gus-Demo-Guidelines-2026-10-06.txt` except Windows line endings introduced by the SQL editor). The same five points are in the default policy for new stores (`DEFAULT_DEMO_POLICY`, both copies), deployed in `2e5d209`. The eight em dashes in the old live text were replaced at the same time. Brands who accepted earlier keep their accepted snapshot.
