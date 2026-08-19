/* =========================================================================
   The voice picker.

   The XTTS voices come from the server; the browser engine is always offered as
   the fast fallback, and becomes the only option when the local XTTS server is
   not running. A saved voice that no longer exists falls back rather than
   leaving the app mute — the picker has to survive `npm run xtts` not running.
   ========================================================================= */

import { state, LS_VOICE } from '../core/state.js';
import { voiceSel } from '../core/dom.js';
import { cancelSpeech, hasSynth } from '../voice/tts.js';
import { applyMuteToUI } from './labels.js';

/* Voice picker. The XTTS voices come from the server; the browser engine is
   always offered as the fast fallback, and becomes the only option when the
   local XTTS server is not running. */
function buildVoicePicker() {
  return fetch('/api/voices')
    .then(function (r) { return r.json(); })
    .then(function (info) {
      voiceSel.innerHTML = '';
      if (info.xtts) {
        (info.voices || []).forEach(function (v) {
          var o = document.createElement('option');
          o.value = v.id;
          o.textContent = v.label + (v.preferred ? ' ★' : '');
          voiceSel.appendChild(o);
        });
      }
      var b = document.createElement('option');
      b.value = 'browser';
      b.textContent = hasSynth() ? 'Prohlížeč (rychlé)' : 'Prohlížeč (nedostupné)';
      b.disabled = !hasSynth();
      voiceSel.appendChild(b);

      var ids = Array.prototype.map.call(voiceSel.options, function (o) { return o.value; });
      if (ids.indexOf(state.voice) === -1) {
        // saved voice is gone (XTTS server down) — fall back rather than break
        state.voice = info.xtts ? (info.defaultVoice || ids[0]) : 'browser';
      }
      voiceSel.value = state.voice;
      if (!info.xtts) {
        voiceSel.title = 'Hlasový server neběží (npm run xtts) — jen prohlížečový hlas.';
      }
      applyMuteToUI();
    })
    .catch(function () {
      voiceSel.innerHTML = '<option value="browser">Prohlížeč</option>';
      state.voice = 'browser';
    });
}

export function initVoicePicker() {
  voiceSel.addEventListener('change', function () {
    cancelSpeech();                     // never let the old voice finish the sentence
    state.voice = voiceSel.value;
    try { localStorage.setItem(LS_VOICE, state.voice); } catch (e) {}
    applyMuteToUI();
  });

  return buildVoicePicker();
}
