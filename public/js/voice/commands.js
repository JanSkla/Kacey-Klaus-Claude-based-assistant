/* =========================================================================
   SPOKEN COMMANDS — not messages.

   Neither of these is sent to Kacey and neither is logged. They are things
   said TO the interface: a reply to "to je vše, díky" is just one more thing
   to sit through, and the log has to mirror what the model actually saw.

   'end'       after a reply: stop the hands-free loop. The wake word is a
               separate setting with its own button and is not touched here.
   'interrupt' during a reply: stop talking, stop generating. The conversation
               stays open, so the microphone re-opens as usual.

   The phrase matching itself is in closing.js (a classic script, so the Node
   tests can load it) — this module is only what happens once one is heard.
   ========================================================================= */

import { state } from '../core/state.js';
import { t } from '../core/i18n.js';
import { syncOrb } from '../ui/orb.js';
import { flashHint, endAssistant } from '../ui/log.js';
import { cancelSpeech } from './tts.js';
import { playCloseChime } from './chime.js';
import { clearStaleComposer, stopRecognition, maybeResumeVoiceLoop } from './recognition.js';
import { superviseWake } from './wake.js';
import { sendFrame } from '../net/protocol.js';

export function endListening() {
  clearStaleComposer();
  state.resumeVoiceLoop = false;
  state.micDesired = false;
  state.ttsSuspendedRec = false;
  stopRecognition(true);
  superviseWake();          // hands the microphone back to the wake listener
  playCloseChime();
  flashHint(t().closed, false, 5000);
  syncOrb();
}

/* Barge-in. Unlike endListening this leaves resumeVoiceLoop alone: you said
   "ticho" to stop her talking, not to end the conversation, so the loop
   re-opens the microphone once the cancelled speech has settled. */
export function bargeIn() {
  // Reached from the barge-in listener, which never goes through submit() —
  // so this is the only place that can tidy up after it.
  clearStaleComposer();
  var wasBusy = state.streaming || state.ttsPending > 0;
  cancelSpeech();
  if (state.streaming) sendFrame({ type: 'interrupt' });
  endAssistant();
  playCloseChime();
  flashHint(t().silenced, false, 2200);
  syncOrb();
  // cancelSpeech() zeroes ttsPending without firing onAllSpeechDone, so the
  // loop has to be nudged by hand or the microphone never comes back.
  if (state.resumeVoiceLoop || state.micDesired) {
    setTimeout(maybeResumeVoiceLoop, 400);
  }
  return wasBusy;
}
