/* =========================================================================
   TELLING THE SERVER SOMEBODY IS THERE.

   The night routine (docs/DREAM.md §7) needs to know when the owner does
   something: an hour of nothing after the lightsd sleep button means asleep,
   and any real interaction cancels that. This sends one `interaction` frame
   per signal, throttled so a burst of typing is one frame, not two hundred.

   What counts: a tap or a click (pointerdown), a key, a touch, the wake word.
   What does not: moving the mouse. The OS wakes a dark panel on a mouse move
   by itself, and a cat on the touchpad must not cancel the night.

   Sent only when the server's `ready` frame lists the 'night' feature — an
   older server answers an unknown frame with an error, which would alert.
   ========================================================================= */

import { sendFrame, serverHas } from './protocol.js';

var THROTTLE_MS = 10000;
var lastSent = 0;

export function noteInteraction(kind) {
  if (!serverHas('night')) return;
  var now = Date.now();
  // The wake word is rare and it matters: never swallowed by the throttle.
  if (kind !== 'wake' && now - lastSent < THROTTLE_MS) return;
  lastSent = now;
  sendFrame({ type: 'interaction', kind: kind });
}

export function initActivity() {
  var kinds = { pointerdown: 'pointer', keydown: 'key', touchstart: 'touch' };
  Object.keys(kinds).forEach(function (ev) {
    // Capture phase and passive: this watches, it never interferes.
    window.addEventListener(ev, function () { noteInteraction(kinds[ev]); }, { capture: true, passive: true });
  });
}
