/* =========================================================================
   Which day it is — kept current, not read once.

   Everything in the page that says "today" asks due.js logicalToday(), which is
   right whenever it is called. What went wrong was that some of it was only
   asked at load: the calendar's `today` came with the month fetched at boot,
   the routine's phone day was set when the module ran. A page left open on the
   phone overnight then showed Wednesday all of Thursday.

   This watches the logical day (it turns at 04:00, due.js DAY_START_HOUR) and
   tells the views when it moved, on the bus:

     'day'    { from, to }   the logical date changed — refetch and redraw
     'clock'  { day }        the page is back (shown again, focused, online,
                             the phone woke up, the Android app resumed) —
                             redraw anything that shows the time; `day` is
                             true when 'day' went out just before

   Timers do not run while a phone sleeps or the app sits in the background,
   so the minute tick alone is not enough: every way the page can come back
   checks at once, and a tick that arrives far later than it should counts as
   waking up.
   ========================================================================= */

import * as bus from './bus.js';
import { logicalToday } from './due.js';

var TICK_MS = 30000;
var current = null;
var lastTick = 0;

/** The logical date the page currently shows. */
export function today() { return current || logicalToday(); }

/** Look at the clock now. Returns true when the day had moved. */
export function checkDay(reason) {
  var now = logicalToday();
  if (now === current) return false;
  var from = current;
  current = now;
  if (from) bus.emit('day', { from: from, to: now, reason: reason || 'tick' });
  return !!from;
}

function resumed(reason) {
  var moved = checkDay(reason);
  bus.emit('clock', { day: moved, reason: reason });
}

export function initClock() {
  current = logicalToday();
  lastTick = Date.now();

  setInterval(function () {
    var now = Date.now();
    // A tick two periods late means the timers were frozen: the device slept.
    var slept = now - lastTick > TICK_MS * 2;
    lastTick = now;
    if (slept) resumed('wake');
    else if (checkDay('tick')) bus.emit('clock', { day: true, reason: 'tick' });
  }, TICK_MS);

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) resumed('visible');
  });
  window.addEventListener('pageshow', function () { resumed('pageshow'); });
  window.addEventListener('focus', function () { resumed('focus'); });
  window.addEventListener('online', function () { resumed('online'); });
  // The Android app's WebView may never go hidden; its activity says so instead.
  window.addEventListener('kacey-resume', function () { resumed('resume'); });
}
