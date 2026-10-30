/* =========================================================================
   Hlasitost Kacey — Controller → Hlas.

   How loud her own voice is, 0–100 % in steps of 5. Stored in
   settings.ttsVolume, so it holds after a restart and on every device, and
   Kacey can set it herself when asked in the chat (app_voice_volume, which
   writes ttsVolumeBy: 'kacey' — the row then flashes and says so). The music
   is not touched: nowplayingd has its own volume in the mini player.

   The slider repaints as it moves and an XTTS sentence already playing
   follows it at once; the value is saved when it is let go (or by − / +),
   through store.setVoiceVolume → PUT /api/voice/volume, and the other pages
   follow. Offline it holds here and the meta line says it is not saved yet.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as store from '../core/store.js';
import { state } from '../core/state.js';
import { onEnter } from '../ui/router.js';
import { say } from '../ui/toast.js';
import { primeTTS, cancelSpeech, feedTTS, flushTTS, applySpeechVolume, mediaVolumeWorks } from '../voice/tts.js';
import { STEP, clampVolume, volumeOf, volumeWords } from '../core/voicevolume.js';

var seen = null;           // the last value painted, to spot one that came from elsewhere
var dragging = false;
var whenWord = function () { return ''; };

function stored() { return volumeOf(store.data.settings); }

function paint(v) {
  var range = $('ttsVolRange');
  if (!range) return;
  var words = volumeWords(v);
  range.value = String(v);
  range.style.setProperty('--v', v + '%');
  range.setAttribute('aria-valuetext', words);
  $('ttsVolNum').textContent = words;
  $('ttsVolDown').disabled = v <= 0;
  $('ttsVolUp').disabled = v >= 100;
  $('ttsVol').classList.toggle('is-silent', v === 0);
}

function meta(v) {
  var s = store.data.settings;
  if (store.voiceVolumeUnsaved()) return 'Offline — hlasitost platí tady, uložím ji, až se připojím.';
  if (!store.isLoaded()) return 'Server neodpovídá — uloženou hlasitost načtu, až se připojím.';
  if (state.muted) return 'Čtení nahlas je vypnuté — hlasitost se použije, až ho zapneš.';
  if (state.voice !== 'browser' && !mediaVolumeWorks()) return 'Na tomhle zařízení hlasitost řídí jen tlačítka telefonu.';
  if (v === 0) return 'Ticho — odpovědi poběží, ale nebude je slyšet.';
  if (s.ttsVolumeBy === 'kacey' && s.ttsVolumeAt) return 'Nastavila Kacey ' + whenWord(s.ttsVolumeAt) + ' · hudba má hlasitost vlastní.';
  return 'Jen její hlas — hudba má hlasitost vlastní.';
}

function render() {
  if (!$('ttsVol') || dragging) return;
  var v = stored();
  // Changed somewhere else (Kacey from the chat, the other device): show where it landed.
  if (seen !== null && v !== seen && store.data.settings.ttsVolumeBy === 'kacey') flash();
  seen = v;
  paint(v);
  $('ttsVol').classList.toggle('is-muted', !!state.muted);
  $('ttsVol').classList.toggle('is-off', store.voiceVolumeUnsaved() || !store.isLoaded());
  $('ttsVolMeta').textContent = meta(v);
}

function flash() {
  var row = $('ttsVol');
  row.classList.remove('is-new');
  void row.offsetWidth;    // restart the animation
  row.classList.add('is-new');
}

function commit(v) {
  v = clampVolume(v);
  seen = v;                // our own change: no flash
  store.setVoiceVolume(v);
  applySpeechVolume();
}

export function initTtsVolume(opts) {
  var range = $('ttsVolRange');
  if (!range) return;
  if (opts && opts.whenWord) whenWord = opts.whenWord;

  range.addEventListener('input', function () {
    dragging = true;
    var v = Number(range.value);
    paint(v);
    // Heard straight away while she speaks; saved on release.
    applySpeechVolume(v);
  });
  range.addEventListener('change', function () {
    dragging = false;
    commit(Number(range.value));
  });
  $('ttsVolDown').addEventListener('click', function () { commit(stored() - STEP); });
  $('ttsVolUp').addEventListener('click', function () { commit(stored() + STEP); });
  // Released outside the page (a phone's thumb slides off): still saved.
  range.addEventListener('blur', function () { if (dragging) { dragging = false; commit(Number(range.value)); } });

  $('ttsVolTry').addEventListener('click', function () {
    if (state.muted) { say('Čtení nahlas je vypnuté — zapni „Číst odpovědi nahlas“.'); return; }
    primeTTS();
    cancelSpeech();
    feedTTS(stored() === 0 ? 'Teď mě neuslyšíš. ' : 'Takhle nahlas teď mluvím. ');
    flushTTS();
  });

  // The mute switch rewrites the meta line.
  if ($('mute')) $('mute').addEventListener('click', function () { setTimeout(render, 0); });

  onEnter('controller', render);
  store.onChange(render);
  render();
}
