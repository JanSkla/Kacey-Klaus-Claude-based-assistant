/* =========================================================================
   The console / automation surface.

   Two globals, and they exist because the interesting paths cannot be reached
   by hand: a wake word needs a microphone and the right room, a barge-in needs
   a reply already being spoken. These let a headless browser — or you, at 2am —
   drive them directly and read back what the app currently believes.

   Nothing here is load-bearing. Each subsystem reports its own status through
   an exported function, so a new flag shows up in the readout by being added
   next to the flags it belongs with, rather than by being remembered here.
   ========================================================================= */

import { state } from './core/state.js';
import { orbState } from './ui/orb.js';
import { submit, onServer, onConn } from './net/protocol.js';
import { endListening, bargeIn } from './voice/commands.js';
import { bargeStatus } from './voice/barge.js';
import { isWakePhrase, normalizeHeard, wakeStatus, feedWake } from './voice/wake.js';
import { setWakeMode, openVoicePanel, onVoiceDetect } from './voice/wake-panel.js';

export function installDebugSurface() {
  window.kaceyWake = {
    isWakePhrase: isWakePhrase,
    normalize: normalizeHeard,
    status: wakeStatus,
    setMode: setWakeMode,
    panel: openVoicePanel,
    // Run the voice trigger path without a microphone.
    fireVoice: function () {
      onVoiceDetect({ score: 0, threshold: 1, template: 0 });
      return true;
    },
    // Simulate what the transcript engine would have heard.
    feed: feedWake,
  };

  window.kacey = {
    state: state,
    classifyClosing: function (s) {
      return window.KaceyClosing ? window.KaceyClosing.classify(s) : null;
    },
    endListening: endListening,
    bargeIn: bargeIn,
    barge: bargeStatus,
    send: submit,
    inject: onServer,
    conn: onConn,
    orb: orbState
  };
}
