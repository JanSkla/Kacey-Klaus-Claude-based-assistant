/* =========================================================================
   When a task is due — shared by the browser and the server.

   A task's `due_at` is local time in one of two shapes, or nothing:
     'YYYY-MM-DD'        some time that day
     'YYYY-MM-DDTHH:MM'  at that time — a calendar-shaped task, drawn in the
                         calendar's lane for `duration` minutes
     null                whenever

   Which group a task sits in (po termínu, dnes, tento týden, …) is never
   stored. It is worked out from `due_at` and the clock every time it is
   shown, so "today" really is today tomorrow too.

   "Today" is the logical day, which ends at 04:00 like everywhere else in
   Kacey (config.js LOGICAL_DAY_START_HOUR): at 01:30 it is still yesterday.

   No DOM here, and no imports: server.js loads this file as it is.
   ========================================================================= */

export var DAY_START_HOUR = 4;

var SHAPE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/;

function pad(n) { return String(n).padStart(2, '0'); }

function dateOf(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 'YYYY-MM-DD' plus n days. Noon, so no DST edge can move it. */
export function addDays(date, n) {
  var p = date.split('-').map(Number);
  return dateOf(new Date(p[0], p[1] - 1, p[2] + n, 12));
}

/** Monday-first weekday index, 0..6. */
export function dowOf(date) {
  var p = date.split('-').map(Number);
  return (new Date(p[0], p[1] - 1, p[2], 12).getDay() + 6) % 7;
}

export function logicalToday(now, startHour) {
  var h = startHour === undefined ? DAY_START_HOUR : startHour;
  return dateOf(new Date((now || new Date()).getTime() - h * 3600000));
}

/**
 * The canonical form of whatever was given, or null for "no date".
 * Accepts a space for the T and ignores seconds and zones; throws on
 * something that is not a date at all, so a caller can say so.
 */
export function normalizeDue(value) {
  if (value === null || value === undefined || value === '') return null;
  var m = SHAPE.exec(String(value).trim());
  if (!m) throw new Error('Termín musí být YYYY-MM-DD nebo YYYY-MM-DDTHH:MM, ne "' + value + '".');
  var p = m[1].split('-').map(Number);
  var d = new Date(p[0], p[1] - 1, p[2], 12);
  if (d.getMonth() !== p[1] - 1 || d.getDate() !== p[2]) throw new Error('Neexistující datum "' + m[1] + '".');
  if (m[2] === undefined) return m[1];
  if (Number(m[2]) > 23 || Number(m[3]) > 59) throw new Error('Neexistující čas "' + m[2] + ':' + m[3] + '".');
  return m[1] + 'T' + m[2] + ':' + m[3];
}

/** { date, time, minutes } of a due_at, time/minutes null when it has none. */
export function parseDue(due) {
  var m = due ? SHAPE.exec(due) : null;
  if (!m) return null;
  if (m[2] === undefined) return { date: m[1], time: null, minutes: null };
  return { date: m[1], time: m[2] + ':' + m[3], minutes: Number(m[2]) * 60 + Number(m[3]) };
}

/**
 * Where a task goes in the list:
 *   'overdue' — not done, and its day is gone, or its time is (a timed task
 *               at 15:00 is late at 15:01)
 *   'past'    — done, and its day is gone
 *   'today'   — due today
 *   'week'    — later this week, up to Sunday
 *   'later'   — after this week
 *   'none'    — no date
 */
export function bucketOf(task, now) {
  var p = parseDue(task && task.due_at);
  if (!p) return 'none';
  now = now || new Date();
  var today = logicalToday(now);
  if (p.date < today) return task.done ? 'past' : 'overdue';
  if (!task.done && p.time && p.date === dateOf(now) && p.minutes < now.getHours() * 60 + now.getMinutes()) return 'overdue';
  if (p.date === today) return 'today';
  if (p.date <= addDays(today, 6 - dowOf(today))) return 'week';
  return 'later';
}

var DOW = ['po', 'út', 'st', 'čt', 'pá', 'so', 'ne'];

/** Short Czech words for a due_at: "dnes 15:00", "zítra", "st 1. 10.", "3. 1. 2027". */
export function dueLabel(due, now) {
  var p = parseDue(due);
  if (!p) return '';
  now = now || new Date();
  var today = logicalToday(now);
  var d = p.date.split('-').map(Number);
  var word;
  if (p.date === today) word = 'dnes';
  else if (p.date === addDays(today, 1)) word = 'zítra';
  else if (p.date === addDays(today, -1)) word = 'včera';
  else {
    word = d[2] + '. ' + d[1] + '.';
    if (String(d[0]) !== today.slice(0, 4)) word += ' ' + d[0];
    else if (p.date > addDays(today, -7) && p.date < addDays(today, 14)) word = DOW[dowOf(p.date)] + ' ' + word;
  }
  return p.time ? word + ' ' + p.time : word;
}

/**
 * What a task stored under the old fixed groups meant, as a date: 'today'
 * was today, 'overdue' was some day already gone, 'week' was by Sunday.
 * Used once, to carry old rows (and old JSON imports) over.
 */
export function dueFromGroup(group, now, startHour) {
  var today = logicalToday(now, startHour);
  if (group === 'overdue') return addDays(today, -1);
  if (group === 'week') return addDays(today, 6 - dowOf(today));
  if (group === 'today') return today;
  return null;
}
