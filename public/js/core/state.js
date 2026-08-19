/* =========================================================================
   The shared state bag, the localStorage keys, and the mock switch.

   Everything that more than one module needs to agree on lives here, and
   nowhere else — a second copy of "are we listening" is a bug waiting for a
   race to find it. Restoring these from localStorage is boot's job (app.js),
   not this module's: reading storage has to happen once, in a known order.
   ========================================================================= */

/* every persisted preference, in one place */
export var LS_LANG = 'kacey.lang';
export var LS_MUTED = 'kacey.muted';
export var LS_VOICE = 'kacey.voice';
export var LS_WAKE = 'kacey.wake';
export var LS_WAKE_MODE = 'kacey.wake.mode';    // 'voice' (my recording) | 'asr' (transcript)
export var LS_HUE = 'kacey.hue';

export var LANGS = ['cs-CZ', 'en-US'];

export var MOCK = /(?:^|[?&])mock=1(?:&|$)/.test(location.search);

export var state = {
  lang: 'cs-CZ',
  muted: false,
  conn: 'connecting',      // connecting | online | offline
  streaming: false,        // a reply is in flight
  listening: false,        // recognition is actually running
  micDesired: false,       // the user wants the mic on
  resumeVoiceLoop: false,  // last turn came from voice -> re-open the mic after TTS
  ttsPending: 0,           // utterances queued/being spoken
  ttsSuspendedRec: false,  // recognition was stopped by us because TTS started
  errorUntil: 0,
  sessionId: null,
  voiceWarned: false,
  voice: 'Nova Hogarth'    // XTTS speaker, or 'browser' for the built-in engine
};
