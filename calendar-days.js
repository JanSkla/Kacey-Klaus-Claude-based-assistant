/**
 * Kacey — which days a calendar event is on.
 *
 * The calendar day model from ARCHITECTURE.md § The calendar day model: a day
 * starts at 04:00, all-day events opt out of that shift, and an event occupies
 * a range of days. It used to live inside server.js; it moved here unchanged
 * when the night routine's rules needed the same answer (docs/DREAM.md §8), so
 * the calendar view and the rule engine cannot disagree about which day an
 * event is on.
 *
 * Pure: no I/O, no database. test/rules.mjs imports it.
 */

import { LOGICAL_DAY_START_HOUR } from './config.js';

/** Local calendar date of a Date, as 'YYYY-MM-DD'. */
export function calDayOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function logicalDayOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return calDayOf(new Date(d.getTime() - LOGICAL_DAY_START_HOUR * 3600 * 1000));
}

/* All-day events arrive from the calendar sync as whole clock days: midnight to
   midnight with an EXCLUSIVE end, or midnight to 23:59. They must not get the
   4-hour logical-day shift — midnight belongs to the previous logical day, so a
   holiday starting at 00:00 on the 26th would be filed as starting on the 25th
   and ending a day early. Detect the shape and use plain calendar days for it. */
export function isAllDay(startIso, endIso) {
  if (!endIso) return false;
  const s = new Date(startIso), e = new Date(endIso);
  if (isNaN(s) || isNaN(e)) return false;
  if (s.getHours() !== 0 || s.getMinutes() !== 0) return false;
  const endsAtMidnight = e.getHours() === 0 && e.getMinutes() === 0;
  const endsAtDayEnd = e.getHours() === 23 && e.getMinutes() === 59;
  if (!endsAtMidnight && !endsAtDayEnd) return false;
  return e.getTime() - s.getTime() >= 20 * 3600 * 1000;    // at least most of a day
}

/* The inclusive range of days an event occupies. The end is treated as
   exclusive throughout — an event ending at 00:00, or at 04:00 for a timed one,
   does not reach into the day that begins there. */
export function dayRangeOf(r) {
  const s = new Date(r.starts_at);
  if (isNaN(s)) return null;
  const allDay = isAllDay(r.starts_at, r.ends_at);
  const first = allDay ? calDayOf(s) : logicalDayOf(r.starts_at);
  if (!first) return null;

  let last = first;
  if (r.ends_at) {
    const e = new Date(r.ends_at);
    if (!isNaN(e) && e.getTime() > s.getTime()) {
      const endMoment = new Date(e.getTime() - 1);
      const end = allDay ? calDayOf(endMoment) : logicalDayOf(endMoment.toISOString());
      if (end && end > first) last = end;
    }
  }
  return { first, last, allDay };
}

/** Days since epoch for a 'YYYY-MM-DD'. UTC so a DST change cannot shift it. */
export function dayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
