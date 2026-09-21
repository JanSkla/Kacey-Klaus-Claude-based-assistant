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
var timer = 0;

/**
 * Show a line. `act` optionally puts a button beside it — { label, run } —
 * used for undoing something that already happened. An undoable toast stays up
 * longer, because the whole point is that you get a chance to read it.
 */
export function say(message, act) {
  if (!box) return;
  clearTimeout(timer);
  text.textContent = String(message == null ? '' : message);

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
  timer = setTimeout(clear, act ? 12000 : 3600);
}

export function clear() {
  clearTimeout(timer);
  if (box) box.hidden = true;
  if (action) { action.hidden = true; action.onclick = null; }
}

if (close) close.addEventListener('click', clear);
