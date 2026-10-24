/* =========================================================================
   Přepis řeči — Whisper large v3 or turbo, a row in Controller → Hlas.
   Not beside the talk button: the mic stays one button on the home screen.

   The sidecar on kaceybody holds one of the two; switching drops it and loads
   the other, which takes a minute, and meanwhile dictation falls back to the
   browser's engine (recognition.js engine()). This only shows the state the
   sidecar reports (server-stt.js polls it) and asks for the other model.

     ok    --ok  "připraveno" / "věta za 2,4 s"
     busy  --acc, pulsing  "načítám turbo…", both options held
     off   --ink2  "nedostupný" — Whisper is not running
     err   --err  the chosen model would not load (it fell back to large v3)
   ========================================================================= */

import { onSttStatus, setSttModel, STT_MODELS } from '../voice/server-stt.js';
import { SR } from '../voice/recognition.js';
import { flashHint, showAlert } from './log.js';
import { say } from './toast.js';

var NAMES = { 'large-v3': 'large v3', turbo: 'turbo' };
var box, stateEl, metaEl, opts;
var wasLoading = false;
var asked = null;            // the model this page asked for, to confirm it once loaded

function secs(n) { return String(Math.round(n * 10) / 10).replace('.', ',') + ' s'; }

function render(s) {
  if (!box) return;
  var held = s.loading ? s.choice : s.model;
  var st, text, title;
  if (!s.known) {
    st = 'off'; text = '—'; title = 'Zjišťuji, jestli Whisper běží…';
  } else if (s.loading) {
    st = 'busy'; text = 'načítám ' + (NAMES[s.choice] || s.choice) + '…';
    title = 'Whisper si načítá model ' + (NAMES[s.choice] || s.choice) + ' — trvá to asi minutu. '
      + (SR ? 'Do té doby přepisuje prohlížeč.' : 'Mikrofon zatím počká.');
  } else if (!s.ok) {
    st = 'off'; text = 'nedostupný';
    title = 'Whisper na kaceybody neběží. ' + (SR ? 'Přepisuje prohlížeč.' : 'Zbývá psaní.');
  } else if (s.error) {
    st = 'err'; text = 'turbo nejde';
    title = 'Turbo se nenačetlo, běží large v3. (' + s.error + ')';
  } else {
    st = 'ok';
    text = s.last ? 'věta za ' + secs(s.last.seconds) : 'připraveno';
    title = 'Whisper ' + (NAMES[s.model] || s.model) + ' na kaceybody — zvuk nikam neodchází.'
      + (s.last ? ' Poslední věta za ' + secs(s.last.seconds) + '.' : '');
  }
  box.dataset.st = st;
  stateEl.textContent = text;
  metaEl.textContent = title;
  opts.forEach(function (b) {
    var name = b.getAttribute('data-stt-model');
    b.setAttribute('aria-pressed', String(name === held));
    // Held while a model loads (the sidecar takes one switch at a time), and
    // while there is no Whisper to switch.
    b.disabled = !s.known || s.loading || (!s.ok && !s.model);
  });

  // A switch this page asked for has finished: say so once.
  if (wasLoading && !s.loading && asked) {
    if (s.ok && s.model === asked) say('Přepis řeči teď běží na Whisper ' + NAMES[asked] + '.');
    else if (s.error) showAlert('Whisper ' + (NAMES[asked] || asked) + ' se nenačetl — přepisuje dál large v3.');
    asked = null;
  }
  wasLoading = s.loading;
}

function choose(name) {
  if (STT_MODELS.indexOf(name) === -1) return;
  asked = name;
  flashHint('Přepínám přepis na Whisper ' + NAMES[name] + ' — načtení trvá asi minutu.'
    + (SR ? ' Do té doby přepisuje prohlížeč.' : ''), true, 6000);
  setSttModel(name).catch(function (err) {
    asked = null;
    showAlert('Přepis řeči se nepřepnul — ' + (err && err.message ? err.message : 'Whisper neodpovídá') + '.');
  });
}

export function initSttPicker() {
  box = document.getElementById('sttPick');
  if (!box) return;
  stateEl = document.getElementById('sttPickState');
  metaEl = document.getElementById('sttPickMeta');
  opts = Array.prototype.slice.call(box.querySelectorAll('[data-stt-model]'));
  opts.forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.getAttribute('aria-pressed') === 'true') return;
      choose(b.getAttribute('data-stt-model'));
    });
  });
  onSttStatus(render);
}
