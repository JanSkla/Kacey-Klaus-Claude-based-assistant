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
import { state } from '../core/state.js';

var THROTTLE_MS = 10000;
var PRESENCE_MS = 5000;
var lastSent = 0;
var lastPresence = 0;

export function noteInteraction(kind) {
  if (!serverHas('night')) return;
  var now = Date.now();
  // The wake word is rare and it matters: never swallowed by the throttle.
  if (kind !== 'wake' && now - lastSent < THROTTLE_MS) return;
  lastSent = now;
  sendFrame({ type: 'interaction', kind: kind });
}

/* Orb follower (subscribed in app.js): tell the server when speech starts and
   stops, so the bedside panel stays lit while she talks and its idle clock
   starts when she finishes. Sent on transitions only. */
var wasSpeaking = false;
export function followSpeaking() {
  var now = state.ttsPending > 0;
  if (now === wasSpeaking) return;
  wasSpeaking = now;
  if (serverHas('night')) sendFrame({ type: 'speaking', on: now });
}

export function initActivity() {
  /* Whether Chromium hides the kiosk page when DPMS blanks the panel decides
     whether the wake word keeps listening at night (DREAM.md §6). Reported so
     the server log can answer it on the real machine. */
  document.addEventListener('visibilitychange', function () {
    if (serverHas('night')) sendFrame({ type: 'visibility', state: document.visibilityState });
  });

  /* The mouse over the page: wakes the bedside screen (docs/DREAM.md §6),
     but is sent as `presence`, never as an interaction. */
  ['pointermove', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () {
      var now = Date.now();
      if (now - lastPresence < PRESENCE_MS || !serverHas('night')) return;
      lastPresence = now;
      sendFrame({ type: 'presence' });
    }, { capture: true, passive: true });
  });

  var kinds = { pointerdown: 'pointer', keydown: 'key', touchstart: 'touch' };
  Object.keys(kinds).forEach(function (ev) {
    // Capture phase and passive: this watches, it never interferes.
    window.addEventListener(ev, function () { noteInteraction(kinds[ev]); }, { capture: true, passive: true });
  });
}
