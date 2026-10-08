/* =========================================================================
   The toast.

   One line, bottom left, self-dismissing. Used for the small confirmations the
   interface owes the user ("Task added", "Routine cleared") — never for errors,
   which belong in the alert strip where they persist and are announced
   assertively.
   ========================================================================= */

import { $ } from '../core/dom.js';

var box = $('toast'), text = $('toastText'), close = $('toastClose');
var action = $('toastAction');
var opener = $('toastOpen'), openText = $('toastOpenText');
var timer = 0;

/**
 * Show a line. `act` optionally puts a button beside it — { label, run } —
 * used for undoing something that already happened. An undoable toast stays up
 * longer, because the whole point is that you get a chance to read it.
 * `open`, a function, makes the line itself a button with a "→": it leads to
 * what the toast is about (the task just added, the day just changed). 6 s.
 */
export function say(message, act, open) {
  if (!box) return;
  clearTimeout(timer);
  var line = String(message == null ? '' : message);
  text.textContent = line;
  text.hidden = !!open;
  if (opener) {
    opener.hidden = !open;
    openText.textContent = open ? line : '';
    opener.onclick = open ? function () { clear(); open(); } : null;
  }

  if (action) {
    action.hidden = !act;
    if (act) {
      action.textContent = act.label;
      action.onclick = function () { clear(); act.run(); };
    } else {
      action.onclick = null;
    }
  }

  box.hidden = false;
  timer = setTimeout(clear, act ? 12000 : open ? 6000 : 3600);
}

export function clear() {
  clearTimeout(timer);
  if (box) box.hidden = true;
  if (action) { action.hidden = true; action.onclick = null; }
  if (opener) { opener.hidden = true; opener.onclick = null; }
}

if (close) close.addEventListener('click', clear);
