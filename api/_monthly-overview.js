// api/_monthly-overview.js (2026-10-30): the window the retailer monthly overview email reports on.
//
// The cron sends each retailer one overview a month, on or soon after the 1st. The email names a month
// ("October 2026"), so the figures must come from that calendar month, not from "the last 30 days", which
// used to drift past the month boundary. The month is the one containing (now - 7 days), so a run in the
// first week of November reports October. The end of the window is capped at yesterday (UTC) so a first
// send mid-month never counts demos that have not happened yet.
//
// Demos are never given a "completed" status by anything in the application: a demo that was confirmed
// and whose date has passed simply stays confirmed (or scheduled). So "demos completed" means demos in
// the window whose status is confirmed, scheduled or completed, and never counts cancelled ones.
const ymd = (d) => d.toISOString().slice(0, 10);
export const OVERVIEW_DEMO_STATUSES = ['confirmed', 'scheduled', 'completed'];
export function monthlyOverviewWindow(now = new Date()) {
  const anchor = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 0));
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const to = monthEnd.getTime() < yesterday.getTime() ? monthEnd : yesterday;
  return {
    label: monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    from: ymd(monthStart),
    to: ymd(to),
    // PostgREST filter for "demos that happened in the window": status is one of the live ones.
    demoStatusFilter: 'status=in.(' + OVERVIEW_DEMO_STATUSES.join(',') + ')',
  };
}
