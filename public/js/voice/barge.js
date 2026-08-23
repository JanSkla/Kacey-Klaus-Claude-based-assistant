/* =========================================================================
   BARGE-IN LISTENER — hearing "ticho" while she is still talking.

   The dictation microphone is deliberately closed while Kacey speaks, so
   without this there is no channel an interrupt could arrive through: "ticho"
   would only be heard once she had finished, which is exactly too late.

   So: a THIRD recognition instance, continuous, alive for the whole of her turn
   — from the moment she starts working to the last spoken sentence. Everything
   it hears is discarded except the interrupt phrases. It cannot fight the other
   two for the microphone — dictation is suspended for the duration of a turn,
   and both wake detectors stand down while `streaming` or `ttsPending` is set,
   which is precisely when this one runs.

   Two costs, stated rather than buried:
   - It uses the CLOUD recogniser, so audio leaves the machine while she is
     working. That is the cost the local wake word was built to avoid, and it
     is why this is scoped to her turn and nothing more — it opens on the first
     `thinking` and closes on the last sentence, never while you are idle.
   - It hears her through the speakers. Echo cancellation helps; the guard
     below is what stops her from interrupting herself when the reply happens
     to contain the word.
   ========================================================================= */

import { state } from '../core/state.js';
import { SR, recognitionAvailable } from './recognition.js';
import { voiceWakeStop } from './wake-panel.js';
import { pauseReply, stopAndEnd } from './commands.js';

/* ---- the self-hearing guard --------------------------------------------
   The text of the reply currently being spoken. It lives here rather than in
   tts.js because this is the only module that reads it: the question it answers
   is "did the microphone hear the room, or did it hear us?". */

var bargeSpoken = '';

export function noteSpoken(text) { bargeSpoken += ' ' + text; }
export function clearSpoken() { bargeSpoken = ''; }
function spokenGuard() {
  return !!(window.KaceyClosing && window.KaceyClosing.mentionsInterrupt(bargeSpoken));
}

/* ---- the listener ------------------------------------------------------ */

var bargeAvailable = true;      // cleared for good if the microphone is refused
var bargeRec = null;
var bargeRunning = false;
var bargeBackoffUntil = 0;
var bargeHits = 0;

function bargeShouldRun() {
  if (!bargeAvailable || !recognitionAvailable()) return false;
  if (state.listening || state.micDesired) return false;   // dictation owns the mic
  if (document.hidden || state.conn !== 'online') return false;
  if (Date.now() < bargeBackoffUntil) return false;
  /* The whole turn, not only the part you can hear. "Ticho" during the pause
     before she starts talking used to land on a closed microphone — and that is
     the moment you most want to stop a wrong answer, rather than sitting through
     it first.

     ttsPending covers speaking; streaming covers thinking and tool use. A muted
     reply has no voice to cut off but still has generation to stop, which is
     what streaming catches. */
  return state.ttsPending > 0 || state.streaming;
}

function buildBarge() {
  if (!SR) return null;
  var r = new SR();
  r.lang = state.lang;
  r.continuous = true;
  r.interimResults = true;      // interim fires sooner, and "asap" is the point
  r.maxAlternatives = 1;

  r.onstart = function () { bargeRunning = true; };

  r.onresult = function (ev) {
    var heard = '';
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var alt = ev.results[i][0];
      if (alt) heard += ' ' + alt.transcript;
    }
    if (!heard.trim() || !window.KaceyClosing) return;
    var cmd = window.KaceyClosing.classify(heard);
    // The only two things worth hearing over her own voice. "to je vše" is
    // deliberately not one of them: that is said once she has finished.
    if (cmd !== 'interrupt' && cmd !== 'pause') return;
    // She is saying the word herself — that is the loudspeaker, not the room.
    if (spokenGuard()) return;

    bargeHits++;
    stopBarge(true);
    if (cmd === 'interrupt') stopAndEnd();
    else pauseReply();
  };

  r.onerror = function (ev) {
    var code = (ev && ev.error) || 'unknown';
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      bargeAvailable = false;              // the microphone is refused; stop asking
      return;
    }
    bargeBackoffUntil = Date.now() + (code === 'network' ? 15000 : 700);
  };

  r.onend = function () { bargeRunning = false; };
  return r;
}

function startBarge() {
  if (bargeRunning || !bargeShouldRun()) return;
  if (!bargeRec) bargeRec = buildBarge();
  if (!bargeRec) return;
  bargeRec.lang = state.lang;
  try {
    bargeRec.start();
    bargeRunning = true;
  } catch (e) {
    try { bargeRec.abort(); } catch (e2) {}
    bargeRec = buildBarge();
    bargeRunning = false;
    // Short: the whole window this has to live in is a few seconds long.
    bargeBackoffUntil = Date.now() + 250;
  }
}

export function stopBarge(hard) {
  if (!bargeRec) { bargeRunning = false; return; }
  try { hard ? bargeRec.abort() : bargeRec.stop(); } catch (e) {}
  bargeRunning = false;
}

export function superviseBarge() {
  if (bargeShouldRun()) {
    /* The local wake engine holds the microphone through getUserMedia, and its
       own supervisor only runs every 1.5s — far too slow to have let go by the
       time a reply starts. Release it here rather than racing it. */
    voiceWakeStop();
    startBarge();
  } else if (bargeRunning) {
    stopBarge(true);
  }
}

/* What the console surface reports. Kept beside the flags it reads so a new
   flag cannot quietly go missing from the readout. */
export function bargeStatus() {
  return {
    available: bargeAvailable, running: bargeRunning,
    shouldRun: bargeShouldRun(), hits: bargeHits,
    spokenGuard: spokenGuard()
  };
}
