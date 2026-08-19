/* =========================================================================
   The orb: one derived value that describes the whole app.

   Nothing sets the orb directly. Every module changes `state` and calls
   syncOrb(), which recomputes what the orb should be showing — so the visible
   state cannot drift from the real one, and there is exactly one place that
   decides which condition wins when several are true at once.

   Three things follow the orb rather than being called by it: the telemetry
   rails, the barge-in listener, and the ambient hint. They subscribe on the
   bus (wired in app.js) so that this module does not have to import them.
   ========================================================================= */

import { state } from '../core/state.js';
import * as dom from '../core/dom.js';
import * as bus from '../core/bus.js';

var current = 'boot';

export function orbState() { return current; }

function computeOrbState() {
  if (Date.now() < state.errorUntil) return 'error';
  if (state.conn !== 'online') return 'offline';
  if (state.ttsPending > 0) return 'speaking';   // audio wins: it is what the user perceives
  if (state.streaming) return 'thinking';
  if (state.listening) return 'listening';
  return 'idle';
}

export function syncOrb() {
  var next = computeOrbState();
  if (next !== current) {
    current = next;
    dom.orb.setAttribute('data-state', next);
    startAmpLoop();
  }
  // Emitted on every call, not only on a transition: the followers below track
  // things the orb state does not capture (queue depth, session id, whether the
  // microphone can be taken), and they were always refreshed on every sync.
  bus.emit('orb', next);
}

/* Amplitude loop: a smooth pseudo-noise written into --amp so the orb reads
   as voice/energy rather than a metronome. Runs ONLY while thinking /
   speaking / listening, and never when the tab is hidden or motion is
   reduced — so the idle page costs nothing. */
var rafId = 0;

function ampActive() {
  return !dom.reduceMotion.matches &&
    !document.hidden &&
    (current === 'thinking' || current === 'speaking' || current === 'listening');
}

function ampTick(ts) {
  if (!ampActive()) { rafId = 0; dom.orbAmp.style.setProperty('--amp', '0'); return; }
  var s = ts / 1000;
  var fast = current === 'speaking' ? 1 : 0.45;
  // three incommensurable sines -> organic, non-repeating envelope
  var v = 0.5 +
    0.30 * Math.sin(s * (5.1 * fast + 1.2)) +
    0.14 * Math.sin(s * (11.3 * fast + 2.0) + 1.7) +
    0.06 * Math.sin(s * (19.7 * fast + 3.1) + 0.4);
  if (v < 0) v = 0; else if (v > 1) v = 1;
  if (current === 'listening') v *= 0.55;
  dom.orbAmp.style.setProperty('--amp', v.toFixed(3));
  // The HUD activity meter reads the same envelope the orb does — one source
  // of truth, so the bars can never disagree with what the orb is showing.
  paintMeter(v);
  rafId = requestAnimationFrame(ampTick);
}

var meterBars = null;

/* Bars trail the envelope with a per-bar phase offset, so the meter reads as
   a moving signal rather than twelve identical bars. Idle => flat. */
function paintMeter(v) {
  if (meterBars === null) {
    var box = dom.$('meter');
    meterBars = box ? Array.prototype.slice.call(box.children) : [];
  }
  for (var i = 0; i < meterBars.length; i++) {
    var phase = 1 - Math.abs((i / (meterBars.length - 1)) - 0.5) * 1.3;
    var h = Math.max(3, v * 100 * phase);
    meterBars[i].style.height = h.toFixed(1) + '%';
  }
}

export function startAmpLoop() {
  if (rafId || !ampActive()) {
    if (!ampActive() && rafId) { cancelAnimationFrame(rafId); rafId = 0; dom.orbAmp.style.setProperty('--amp', '0'); }
    return;
  }
  rafId = requestAnimationFrame(ampTick);
}

/* Backgrounding the tab and reducing motion both have to be able to stop the
   loop from outside; neither goes through the orb state. Reducing motion also
   parks the orb at rest, because nothing will come along to repaint it. */
export function stopAmpLoop(clearAmp) {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (clearAmp) dom.orbAmp.style.setProperty('--amp', '0');
}
