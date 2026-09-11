// tests/_fixture_availability.mjs — venue availability for test fixtures (Release B / Codex B-02).
//
// A venue with NO hours accepts NO new reservations (0076): fixtures that book must carry hours and
// a slot list that offers the times they use. Two shapes:
//   HOURLY   1-hour slots 06:00–21:00, open 05:00–23:00 every day — capacity/ledger/isolation suites
//            that need many distinct slots and do not care about length.
//   STANDARD 09:00/1h, 10:00/1h, 11:00/3h, 14:00/3h, 17:00/3h, open 08:00–21:00 every day —
//            notification/reschedule suites whose assertions expect the 3-hour "11:00 AM – 2:00 PM".
const allDays = (windows) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), windows]));

export const HOURLY = Object.freeze({
  schedule: allDays([{ open: '05:00', close: '23:00' }]),
  slots: Array.from({ length: 16 }, (_, i) => ({ start: String(6 + i).padStart(2, '0') + ':00', hours: 1 })),
  blackouts: [],
});
export const STANDARD = Object.freeze({
  schedule: allDays([{ open: '08:00', close: '21:00' }]),
  slots: [{ start: '09:00', hours: 1 }, { start: '10:00', hours: 1 }, { start: '11:00', hours: 3 }, { start: '14:00', hours: 3 }, { start: '17:00', hours: 3 }],
  blackouts: [],
});
export const HOURLY_JSON = JSON.stringify(HOURLY);
export const STANDARD_JSON = JSON.stringify(STANDARD);
