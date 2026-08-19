/* =========================================================================
   The two confirmation sounds.

   Wake confirmation is a SOUND, not words. A spoken or written "I heard you"
   costs a beat of reading and clutters the log; a 160ms chime is understood
   instantly and leaves the log for the actual conversation.

   Synthesised with Web Audio rather than shipped as a file — the page has no
   external assets, and two ramped oscillators are smaller than any encoding of
   them. Ends before dictation starts so it cannot bleed into the recording.
   ========================================================================= */

import { state } from '../core/state.js';

var uiCtx = null;

/* Also the unlock point: an AudioContext starts suspended until a real user
   gesture resumes it, which is why primeTTS() calls this on first interaction. */
export function uiAudio() {
  if (!uiCtx) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { uiCtx = new AC(); } catch (e) { return null; }
  }
  if (uiCtx.state === 'suspended') { try { uiCtx.resume(); } catch (e) {} }
  return uiCtx;
}

export var WAKE_CHIME_MS = 170;

export function playWakeChime() {
  // Respect the mute button: it means "be quiet", and the orb already shows
  // the listening state visually for anyone who muted deliberately.
  if (state.muted) return;
  var ctx = uiAudio();
  if (!ctx) return;
  var now = ctx.currentTime;

  // Two short ascending notes (E6 -> B6): reads as a question being accepted,
  // and sits well above speech frequencies so it is never mistaken for a word.
  [[1318.5, 0], [1975.5, 0.075]].forEach(function (pair) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = pair[0];
    var at = now + pair[1];
    // Ramped envelope; a bare start/stop would click.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.14, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.1);
  });
}

/* The counterpart to the wake chime: same two notes, descending. Read as a
   matched pair, "we started" and "we finished" need no explanation. */
export function playCloseChime() {
  if (state.muted) return;
  var ctx = uiAudio();
  if (!ctx) return;
  var now = ctx.currentTime;
  [[1975.5, 0], [1318.5, 0.085]].forEach(function (pair) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = pair[0];
    var at = now + pair[1];
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.014);
    // Longer release than the wake chime — a close should fall away, not snap.
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.18);
  });
}
