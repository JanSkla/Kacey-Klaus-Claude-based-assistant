/* =========================================================================
   SPOKEN COMMANDS — not messages.

   None of these is sent to Kacey and none is logged. They are things said TO
   the interface: a reply to "to je vše, díky" is just one more thing to sit
   through, and the log has to mirror what the model actually saw.

   'pause'     during a reply: stop talking, stop generating, but stay in the
               conversation — the microphone re-opens as usual.
   'interrupt' during a reply: stop talking, stop generating, and finish. Ends
               the conversation the same way 'end' does.
   'end'       after a reply: stop the hands-free loop. The wake word is a
               separate setting with its own button and is not touched here.

   All three leave the wake word alone, which is what makes an ending
   recoverable: "KC" starts the next conversation.

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

/* ---- the two halves, so the three commands can compose them --------------
   Silencing her and closing the conversation are separate acts: "počkej" wants
   only the first, "ticho" wants both, "to je vše" wants only the second. */

/** Stop the output and abandon the turn. Says nothing about the microphone. */
function silenceReply() {
  var wasBusy = state.streaming || state.ttsPending > 0;
  cancelSpeech();
  if (state.streaming) sendFrame({ type: 'interrupt' });
  endAssistant();
  return wasBusy;
}

/* "počkej" — hold that thought. Unlike the other two this leaves
   resumeVoiceLoop alone: you asked her to stop talking, not to go away, so the
   loop re-opens the microphone once the cancelled speech has settled. */
export function pauseReply() {
  // Reached from the barge-in listener, which never goes through submit() —
  // so this is the only place that can tidy up after it.
  clearStaleComposer();
  var wasBusy = silenceReply();
  playCloseChime();
  flashHint(t().paused, false, 2200);
  syncOrb();
  // cancelSpeech() zeroes ttsPending without firing onAllSpeechDone, so the
  // loop has to be nudged by hand or the microphone never comes back.
  if (state.resumeVoiceLoop || state.micDesired) {
    setTimeout(maybeResumeVoiceLoop, 400);
  }
  return wasBusy;
}

/* "ticho" — enough, and we are done. Silence her, then close the conversation
   exactly the way "to je vše" would, so there is one ending to understand
   rather than two. endListening() owns the chime, the hint, and handing the
   microphone back to the wake word. */
export function stopAndEnd() {
  var wasBusy = silenceReply();
  endListening();
  return wasBusy;
}
