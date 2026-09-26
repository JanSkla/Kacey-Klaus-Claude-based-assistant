/* =========================================================================
   Kacey's listening, told to the music visual.

   nowplayingd's corner widget shows "Poslouchám…" and the live transcript,
   and its "Mluv" button asks this page to listen. The server relays both ways
   (voicebridge.js). Only the kiosk page answers a wake: a phone with Kacey
   open must not start recording because of a tap on the bedside screen.

   Frames, only when the server understands them (feature 'voicecast'):
     voice_page {kiosk, available}   on connect, and when the mic comes or goes
     listening  {on, transcript}     transitions, and the transcript as it grows
   ========================================================================= */

import { state, KIOSK } from '../core/state.js';
import { sendFrame, serverHas } from '../net/protocol.js';
import { recognitionAvailable, startRecognition, stopRecognition } from './recognition.js';

var announced = null;
var wasListening = false;
var lastCast = 0;
var castTimer = 0;
var CAST_MS = 250;

/** Tell the server whether this page can be asked to listen. Sent on change only. */
export function announceVoicePage(force) {
  if (!serverHas('voicecast')) return;
  var available = recognitionAvailable();
  var key = KIOSK + ':' + available;
  if (!force && key === announced) return;
  announced = key;
  sendFrame({ type: 'voice_page', kiosk: !!KIOSK, available: available });
}

/** Orb follower: listening started or stopped. */
export function followListening() {
  if (state.listening === wasListening) return;
  wasListening = state.listening;
  clearTimeout(castTimer);
  if (serverHas('voicecast')) sendFrame({ type: 'listening', on: wasListening, transcript: '' });
}

/** What recognition has heard so far; throttled, the last word always goes out. */
export function castTranscript(text) {
  if (!serverHas('voicecast') || !state.listening) return;
  clearTimeout(castTimer);
  var send = function () {
    lastCast = Date.now();
    if (state.listening) sendFrame({ type: 'listening', on: true, transcript: String(text || '') });
  };
  var wait = CAST_MS - (Date.now() - lastCast);
  if (wait <= 0) send();
  else castTimer = setTimeout(send, wait);
}

/** The widget's "Mluv". */
export function onVoiceWake() {
  if (!KIOSK) return;
  startRecognition();
}

/** The widget's "Stop": drop what was heard, send nothing. */
export function onVoiceStop() {
  if (state.listening) stopRecognition(true);
}

export function initVoicecast() {
  // Server STT is found (or lost) after boot; say so when it changes.
  setInterval(function () { announceVoicePage(false); }, 30000);
}
