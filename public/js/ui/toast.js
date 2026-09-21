/* =========================================================================
   The toast.

   One line, bottom left, self-dismissing. Used for the small confirmations the
   interface owes the user ("Task added", "Routine cleared") — never for errors,
   which belong in the alert strip where they persist and are announced
   assertively.
   ========================================================================= */

import { $ } from '../core/dom.js';

var box = $('toast'), text = $('toastText'), close = $('toastClose');
var timer = 0;

export function say(message) {
  if (!box) return;
  clearTimeout(timer);
  text.textContent = String(message == null ? '' : message);
  box.hidden = false;
  timer = setTimeout(clear, 3600);
}

export function clear() {
  clearTimeout(timer);
  if (box) box.hidden = true;
}

if (close) close.addEventListener('click', clear);
