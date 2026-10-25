/* =========================================================================
   Přepis řeči — Whisper large v3 or turbo, a row in Controller → Hlas.
   Not beside the talk button: the mic stays one button on the home screen.

   The sidecar on kaceybody holds one of the two; switching drops it and loads
   the other, which takes a minute, and meanwhile dictation falls back to the
   browser's engine (recognition.js engine()). This only shows the state the
   server reports (server-stt.js polls /api/stt/health, stt.js keeps the
   owner's choice) and asks for the other model. Kacey switches too (app_stt):
   her switch arrives as an `stt` frame and is said here like the page's own.

     ok    --ok  "připraveno" / "věta za 2,4 s"
     busy  --acc, pulsing  "načítám turbo…", both options held
     off   --ink2  "nedostupný" — Whisper is not running; "offline" — nor is
           the connection to Kacey; options held
     err   --err  the chosen model would not load ("turbo nejde": it fell back
           to large v3; "nenačetl se": nothing runs)
   ========================================================================= */

import { onSttStatus, onSttSwitch, setSttModel, sttStatus, STT_MODELS } from '../voice/server-stt.js';
import { SR } from '../voice/recognition.js';
import { flashHint, showAlert } from './log.js';
import { say } from './toast.js';

var NAMES = { 'large-v3': 'large v3', turbo: 'turbo' };
var box, stateEl, metaEl, opts;
var wasLoading = false;
var asked = null;            // the model this page (or Kacey) asked for, to confirm it once loaded

function secs(n) { return String(Math.round(n * 10) / 10).replace('.', ',') + ' s'; }
function name(m) { return NAMES[m] || m || '—'; }
function fallback() { return SR ? 'Přepisuje prohlížeč.' : 'Zbývá psaní.'; }

function render(s) {
  if (!box) return;
  var held = s.loading ? s.choice : s.model;
  var st, text, title, locked = false;
  if (!s.known) {
    st = 'off'; text = '—'; title = 'Zjišťuji, jestli Whisper běží…'; locked = true;
  } else if (s.offline) {
    st = 'off'; text = 'offline'; locked = true;
    title = 'Jsi offline — stav přepisu ukážu, až se připojím.';
  } else if (s.loading) {
    st = 'busy'; text = 'načítám ' + name(s.choice) + '…'; locked = true;
    title = 'Whisper si načítá model ' + name(s.choice) + ' — trvá to asi minutu. '
      + (SR ? 'Do té doby přepisuje prohlížeč.' : 'Mikrofon zatím počká.');
  } else if (s.unreachable) {
    st = 'off'; text = 'nedostupný'; locked = true;
    title = 'Whisper na kaceybody neběží. ' + fallback() + ' Spustí ho: systemctl --user restart stt.';
  } else if (s.error && s.model) {
    st = 'err'; text = name(s.choice) + ' nejde';
    title = 'Whisper ' + name(s.choice) + ' se nenačetl, přepisuje dál ' + name(s.model) + '. (' + s.error + ')';
  } else if (s.error) {
    st = 'err'; text = 'nenačetl se';
    title = 'Whisper se nenačetl (' + s.error + '). ' + fallback();
  } else if (!s.ok) {
    st = 'off'; text = 'nedostupný'; locked = true;
    title = 'Whisper zatím není připravený. ' + fallback();
  } else {
    st = 'ok';
    text = s.last ? 'věta za ' + secs(s.last.seconds) : 'připraveno';
    title = 'Whisper ' + name(s.model) + ' na kaceybody — zvuk nikam neodchází.'
      + (s.last ? ' Poslední věta za ' + secs(s.last.seconds) + '.' : ' Zatím nic nepřepsal.');
  }
  box.dataset.st = st;
  stateEl.textContent = text;
  metaEl.textContent = title;
  opts.forEach(function (b) {
    var m = b.getAttribute('data-stt-model');
    b.setAttribute('aria-pressed', String(m === held));
    // Held while a model loads (the sidecar takes one switch at a time), and
    // while there is no Whisper (or no server) to switch.
    b.disabled = locked;
  });

  // A switch asked for here or by Kacey has finished: say so once.
  if (wasLoading && !s.loading && asked) {
    if (s.ok && s.model === asked && !s.error) say('Přepis řeči teď běží na Whisper ' + name(asked) + '.');
    else if (s.error) showAlert('Whisper ' + name(asked) + ' se nenačetl — ' + (s.model ? 'přepisuje dál ' + name(s.model) + '.' : 'přepisuje prohlížeč.'));
    asked = null;
  }
  wasLoading = s.loading;
}

function choose(m) {
  if (STT_MODELS.indexOf(m) === -1) return;
  asked = m;
  flashHint('Přepínám přepis na Whisper ' + name(m) + ' — načtení trvá asi minutu.'
    + (SR ? ' Do té doby přepisuje prohlížeč.' : ''), true, 6000);
  setSttModel(m).catch(function (err) {
    asked = null;
    showAlert('Přepis řeči se nepřepnul — ' + (err && err.message ? err.message : 'Whisper neodpovídá') + '.');
  });
}

/* Kacey switched it (app_stt): the hint now, the toast once it has loaded. */
function onSwitch(msg) {
  if (msg.by !== 'kacey' || STT_MODELS.indexOf(msg.choice) === -1) return;
  asked = msg.choice;
  wasLoading = true;
  flashHint('Kacey přepíná přepis na Whisper ' + name(msg.choice) + ' — načtení trvá asi minutu.', true, 6000);
}

export function initSttPicker() {
  box = document.getElementById('sttPick');
  if (!box) return;
  stateEl = document.getElementById('sttPickState');
  metaEl = document.getElementById('sttPickMeta');
  opts = Array.prototype.slice.call(box.querySelectorAll('[data-stt-model]'));
  opts.forEach(function (b) {
    b.addEventListener('click', function () {
      var m = b.getAttribute('data-stt-model');
      // The pressed one again means nothing — unless it is the fallback after
      // a failed switch: then it makes it the choice and clears the error.
      var s = sttStatus();
      if (b.getAttribute('aria-pressed') === 'true' && s.choice === m && !s.error) return;
      choose(m);
    });
  });
  onSttSwitch(onSwitch);
  onSttStatus(render);
}
