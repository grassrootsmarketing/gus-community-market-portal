# UI/interaction audit — remaining follow-ups (2026-08-20)

Four parallel static audits (booking page, retailer admin, brand dashboard, owner+public pages)
produced ~100 findings. Every CRITICAL/HIGH item was fixed the same night (see commits tagged
"audit"). This file is the triage list of the remaining MEDIUM/LOW items, so they don't evaporate.

## Booking page (r/gus/index.html)
- Dead legacy admin block (~lines 2236–2673 pre-fix numbering): compliance/demos/billing/settings
  admin code with no markup on this page; `openComplianceModal`/`saveCompliance` would throw if
  reached; `showView('admin')` targets a missing `#adminView`. DELETE (same class as the
  contact-management block already removed).
- Dead success/ICS path: `#successModal` never opens; `downloadICS`/Google/Outlook calendar
  helpers unreachable since the Stripe-redirect change → brands have NO add-to-calendar anywhere
  post-booking on this page. Product decision: revive on dashboard or delete.
- Sign-in mid-booking dead-ends softly: after `brandSignInVerifyCode()` succeeds nothing reopens
  the booking modal; user must re-click "Pay & Confirm" (cart survives). Consider auto-reopening.
- `bigCalPrev/Next/Today` call an undefined `renderBigCalendar` (unreachable today).
- Tight (7–12 venue) layout: `.location-card > h3` class padding (24px) vs inline 18px margins —
  1-off text alignment.
- Duplicate escape helpers `_esc`/`escapeHtml`; `#landingSubtitle` reached by structural selector.

## Retailer admin (r/gus/admin/index.html)
- Onboarding tour: steps whose targets sit in hidden tab panes are filtered out (bank-connect step
  never shows). Steps should declare a tab and switch before measuring.
- Viewer gate: hide `#welcomeBanner`, `.stats-grid`, `.chart-card` too; route through
  `showAdminTab('calendarSection')` instead of raw replaceState+scroll.
- Contact modal (brand type): stored venue text not among options silently selects venue[0] and
  saving REASSIGNS the contact. Append the legacy value as a selected option instead.
- "Verified brand" chip in demos table: map builds `{url, expires, v}` but check reads
  `doc.verified` — chip can never render.
- Store bulk-upload: dead client-side preview (`handleStoreCsvFile`/`renderBulkPreview`/`parseCsv`
  never called), empty sticky thead, copy says "Click Import stores" vs button "Import <file>",
  `escapeHtml` into `textContent` shows `&amp;`.
- Modal dismissal inconsistent: contact/compliance/store/bulk/team/upgrade close only via buttons
  (no Escape/backdrop); two open/close conventions. One shared helper wanted.
- Policy callout "Almost set up" permanently visible: `#cancellationPolicy` etc. don't exist;
  `_cancelPolicyIsDefault` always true. Drop cancellation_policy from the badge logic or restore
  the textarea.
- `@media` selectors target nonexistent `.cal-day` / `.stat-num` (phones keep desktop sizes).
- Avatar: two contradictory tooltips (data-tooltip + native title) after logo load.
- `event?.target` (deprecated global) in two spots → no loading state in Firefox.
- 3-shift day: "Copy to…" hidden together with "+ Add shift" — can't copy a full day.
- Dead: `buildTabMap`, unreachable post-`return` code in `importStoreCsv` (validRows),
  `togglePreferredShift`, `getSampleDemoForCalendar`, `populateVenueSelect`, `dismissWelcome`,
  `copyWelcomeBookingLink`, support-access toggle remnants, `renderPlanCard`/`#upgradeModal`,
  duplicate `confirmBooking`/`openBillingPortal` declarations, `.ics` filename hardcodes Gus.
- Billing empty-state sub copy overwritten on empty accounts (statRevenueSub/statComplianceSub).
- "Active Brands" tooltip claims a filter the stat doesn't apply.
- Brand contact with no venue renders an empty green pill.

## Brand dashboard (brand/dashboard/index.html)
- Team section unreachable (no nav tab renders it) — add nav entry or delete; invite-role select
  ignored by `sendTeamInvite`; duplicate `#teamInviteError` ids; `#teamInviteModal` unopenable;
  `canDemote/canPromote` computed, никогда used.
- Nav has no breakpoint 761–1165px (tabs wrap into multi-row header on tablet).
- `.perf-stats` 3 columns with no mobile override (overflow at 375px).
- Calendar mobile rule targets `.month-label` (doesn't exist) + `min-width:200px` never relaxed.
- `.notif-switch` checked state uses undefined `--forest-600` (currently dead markup).
- Re-picking the same file after a server reject is a no-op (`input.value` not reset on all paths).
- Listener accumulation: `setupCoiWidget` window drag/drop, `initCatPicker` document click.
- Tour: no exit on first run (Skip hidden, no X/backdrop/Escape); resurrects dismissed welcome
  banner; `contentEditable='plaintext-only'` throws on old Firefox/Safari (inline rename dead).
- Hamburger `aria-expanded` never updated; drawer lacks focus trap/scroll lock.
- `copyCalsyncUrl` targets nonexistent `#calsyncUrl` (half-deleted feature).
- `.demos-status` pill wraps at 375px (needs nowrap/shrink guard).
- `#confirmModal`/`confirmDialog()` dead (native confirm used everywhere).

## Owner panel (owner/index.html)
- Incident form: loose inputs, Enter does nothing (wrap in <form>).
- `renderGate(msg)` param unused; `_esc` duplicate of `escapeHtml`; migrations-runner functions
  reference deleted markup (delete them); orphaned analytics-era CSS (.range-bar, .kpi-*, etc.).
- Resend-link cooldown label loses the "Didn't get it?" prefix after first use.

## Public pages
- signup: "Your name" + "How many stores?" collected but never sent (`{action,email,store_name}`
  only). Server accept + persist, or drop the fields.
- index.html: tour auto-resume timer survives close (fires on closed overlay, poisons PostHog
  funnel); `__qa` opt-out check always truthy (masked by opt_out_capturing).
- signin: recognized-code path has Enter; retailer/brand Enter handlers added this pass — keep an
  eye on the resend-cooldown label inconsistency ("Resend code" loses its prefix).
- FAQ: "retailer uploads each brand's COI to compliance dashboard" answer likely stale vs the
  owner-review flow — verify and rewrite.
