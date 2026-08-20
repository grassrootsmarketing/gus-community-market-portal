# Handoff — add an "Upcoming demos" calendar to the BRAND Overview page

Requested 2026-08-20. David wants the brand dashboard **Overview** tab to show a month calendar of
their demos, the same way retailers see a "Demo Calendar" on their admin. Deferred to a fresh chat
for context budget. This is SMALLER than it looks — the calendar already exists; you're surfacing
a compact copy on Overview.

## What already exists (reuse it, don't rebuild)

File: `brand/dashboard/index.html` (single-file HTML + inline vanilla JS).

- **A full calendar already renders on the Calendar tab.** `renderCalendar()` at ~line **1316**
  builds a month grid into the Calendar pane using module state `_calMonth` / `_calYear`
  (declared ~698) and `changeMonth(delta)` (~1394) for prev/next/today nav.
- **The styles exist:** `.cal-grid` (line ~128, `repeat(7,1fr)`), `.cal-event` with per-status
  colors incl. the held one added recently (`.cal-event.pending/.completed/.cancelled/.declined/.held`,
  ~145–150), `.cal-legend` + `.cal-legend-dot.*` (~150–155), and a `@media (max-width:760px)` block
  (~129) that already covers `.cal-grid`/`.cal-head h3`/`.perf-stats`.
- **Demo data is in scope:** `renderOverview()` (~line **1004**) already computes from `_data.demos`
  (which includes provisional `held` rows merged in at load, ~675–695). It already has an "Upcoming
  demos" STAT (`upcoming`, ~1010/1267). `openDemoDetail(demoId)` (~1364) opens a demo's detail
  modal on click — reuse it for calendar-cell clicks.
- **Reference implementation** (what David is comparing to): retailer admin
  `r/gus/admin/index.html` — `.big-cal-card` / "Demo Calendar" (~815), `demoCalGrid` (873),
  `renderDemoCalendar`-style code (~4567). Same visual language.

## The task

Add a calendar card to the Overview render (in `renderOverview()`), showing the current month with
the brand's demos as colored events, click-through to `openDemoDetail`, and prev/next/today nav —
reusing the existing `.cal-grid`/`.cal-event`/`.cal-legend` CSS.

## Recommended approach (least risk, ~40–70 lines)

The existing `renderCalendar()` is coupled to the Calendar tab (it writes to that pane and re-runs
the whole tab). Don't fight it — factor out a pure grid builder and call it from BOTH places:

1. **Extract a pure function** `demoCalendarHtml(year, month)` that returns the month-grid HTML
   string (the guts currently inside `renderCalendar()` from the `firstDow`/`daysInMonth` loop
   through the `.cal-grid` close + legend). It should:
   - read `_data.demos`, bucket by `demo_date` (YYYY-MM-DD, LOCAL — do NOT use toISOString; build
     the date string with padded local getFullYear/getMonth/getDate, matching the fix pattern used
     elsewhere tonight).
   - emit one `.cal-event ${status}` per demo per day (status lowercased; held demos already have a
     color + legend entry).
   - make each event/day clickable → `onclick="openDemoDetail('${demo.id}')"` (id is a UUID, safe
     to interpolate; do NOT interpolate names).
2. **Refactor `renderCalendar()`** (Calendar tab) to just `container.innerHTML = header + nav +
   demoCalendarHtml(_calYear, _calMonth) + legend;` — behavior unchanged.
3. **In `renderOverview()`**, insert a new card (place it after the Performance card or after the
   "Recent demos" list — David's screenshot shows it under Performance):
   ```
   <div class="card">
     <h2>Upcoming demos</h2>
     <div class="sub">Your demos across every Demohub retailer.</div>
     <div class="cal-head">… prev / month label / next / Today …</div>
     ${demoCalendarHtml(_calYear, _calMonth)}
     <div class="cal-legend">…confirmed / pending / held / completed / cancelled…</div>
   </div>
   ```
   Wire the overview nav buttons to `changeMonth(delta)` (which already re-renders the active tab
   via `render()` — confirm it re-renders Overview when that's the current tab; if not, have
   changeMonth call `render()` so BOTH the overview card and the calendar tab track the same
   `_calMonth`/`_calYear`).

## Gotchas (learned tonight)

- **Local date strings, never `toISOString().slice(0,10)`** — UTC shifts the day for +offset users
  (this exact bug was fixed in `r/gus/index.html` and the admin "today" ring tonight). Use
  `dateToYmd`-style local formatting.
- **Only interpolate UUIDs into generated onclick.** Names/emails with apostrophes break inline
  handlers (fixed in ~4 places tonight). `openDemoDetail('${d.id}')` is fine.
- **`_data.demos` already includes `held` provisional rows** (merged at load) — they should show on
  the calendar with the held color, so filter for display status, not payment status.
- **Month-state sharing:** `_calMonth`/`_calYear` are module-level and shared. If Overview and the
  Calendar tab both render from them, `changeMonth` must re-render whichever tab is active. Make
  `changeMonth` call `render()` (the tab dispatcher) rather than `renderCalendar()` directly, so it
  works from either tab.
- **`countUpStats`** (`.perf-stat .val`, ~1282) animates numbers — the calendar has none, so no
  interaction, but don't give calendar cells a class it scoops up.

## Verify

- `node tools/check-html-undef.mjs` (no undefined identifiers in inline script).
- Load `/brand/dashboard` for a brand with demos; confirm the Overview calendar shows events on the
  right days, prev/next/today works, clicking an event opens the detail modal, held demos show the
  held color, and it reflows on mobile.
- Then commit + push (repo git uses `gh auth git-credential`; plain `git push origin main` works).

## Scope guard

Read-only, additive UI change. No API, DB, or money-path changes. Should be a single commit to
`brand/dashboard/index.html`.
