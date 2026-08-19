/* =========================================================================
   Re-labelling the chrome when a preference changes.

   Language and mute are the two settings that rewrite the interface rather
   than change its behaviour, so both have one function that repaints every
   affected control from scratch. Sprinkling the individual updates through the
   change handlers is how half a UI ends up in the old language.
   ========================================================================= */

import { state, MOCK } from '../core/state.js';
import { t } from '../core/i18n.js';
import * as dom from '../core/dom.js';
import { flashHint } from './log.js';
import { hasSynth } from '../voice/tts.js';
import { SR, micBlocked } from '../voice/recognition.js';
import { readyInfo } from '../net/protocol.js';

export function applyLangToUI() {
  var s = t();
  document.documentElement.lang = state.lang.split('-')[0];
  dom.langSel.value = state.lang;
  dom.langLabel.textContent = s.langLabel;
  dom.inputLabel.textContent = s.inputLabel;
  dom.input.placeholder = s.placeholder;
  dom.sendBtn.setAttribute('aria-label', s.send);
  dom.sendBtn.title = s.send;
  dom.stopBtn.setAttribute('aria-label', s.stop);
  dom.stopBtn.title = s.stop;
  applyMuteToUI();
  if (!SR) {
    dom.micNote.textContent = s.errUnsupported;
  } else if (micBlocked()) {
    dom.micNote.textContent = s.errDenied;
  } else {
    dom.micNote.textContent = state.listening ? s.listenHold : s.micHint;
  }
  dom.micBtn.setAttribute('aria-label', state.listening ? s.micStop : s.micStart);
  // re-label the connection pill without restarting any retry countdown
  dom.connLabel.textContent = state.conn === 'online' ? (readyInfo() ? s.online : s.connecting)
    : state.conn === 'connecting' ? s.connecting : s.offline;
  if (MOCK) flashHint(s.mockHint, false, 5000);
}

export function applyMuteToUI() {
  var s = t();
  var label = state.muted ? s.muteOff : s.muteOn;
  dom.muteBtn.setAttribute('aria-pressed', String(state.muted));
  dom.muteBtn.setAttribute('aria-label', label);
  dom.muteBtn.title = label;
  if (!hasSynth() && state.voice === 'browser') {
    dom.muteBtn.disabled = true;
    dom.muteBtn.title = s.errNoTTS;
    dom.muteBtn.setAttribute('aria-label', s.errNoTTS);
  } else {
    dom.muteBtn.disabled = false;
  }
}
