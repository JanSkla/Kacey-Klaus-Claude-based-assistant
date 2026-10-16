/* =========================================================================
   THE MAIN VIEW's own furniture.

   The chat, the composer and the microphone are wired in app.js — they are the
   app, not a view. What is left here is the rail: what Kacey is doing right
   now, what is next, and the header counters.

   Everything on this rail is derived. Nothing is a stored copy of something
   else, so it cannot disagree with the view it is summarising.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { state } from '../core/state.js';
import { orbState } from '../ui/orb.js';
import * as bus from '../core/bus.js';
import { nextUp } from '../ui/calendar.js';
import { submit } from '../net/protocol.js';
import { go } from '../ui/router.js';
import { taskSummary } from './tasks.js';
import * as store from '../core/store.js';
import { today } from '../core/clock.js';
import { dayWords } from '../core/due.js';
import { say } from '../ui/toast.js';

/* Which day the page believes it is, said out loud on the Dnes card
   ("Dnes · čt 15. října") and, on a phone, over "next up" — so a stale day
   shows as one, instead of as an oddly empty agenda. */
function paintDate() {
  $('todayDate').textContent = ' · ' + dayWords(today(), 'medium');
  if ($('nextDate')) $('nextDate').textContent = ' · ' + dayWords(today(), 'short');
}

/* A new day reloads the app document: the night run wrote tasks and the
   morning since boot. When it cannot — offline, or edits of this page still
   on their way out — it stays owed and is tried again whenever the page comes
   back, and every minute. */
var owed = false;
var reloading = false;

function reloadForDay() {
  if (reloading) return Promise.resolve(null);
  reloading = true;
  return store.reloadIfIdle().then(function (fresh) {
    reloading = false;
    owed = fresh !== true;
    return fresh;
  });
}

/* The phone header has room for three words, not a sentence. */
var STATE_SHORT = {
  idle: 'čekám na „KC“', listening: 'poslouchám', thinking: 'přemýšlím',
  speaking: 'mluvím', offline: 'offline', error: 'chyba', boot: 'startuju'
};

var STATE_WORDS = {
  idle: ['Idle', 'Budicí slovo připraveno.'],
  listening: ['Poslouchám', 'Mluv — přestanu, až přestaneš ty.'],
  thinking: ['Přemýšlím', 'Koukám do kalendáře a paměti.'],
  speaking: ['Mluvím', 'Řekni „ticho“, když chceš přestat.'],
  offline: ['Offline', 'Zkouším se připojit zpátky.'],
  error: ['Chyba', 'Něco se nepovedlo — podrobnosti nahoře.'],
  boot: ['Startuju', 'Navazuju spojení.']
};

/* The turn count is telemetry's, read back off the rail it already fills — a
   second counter here is a second thing that can be wrong. */
function turnCount() {
  var node = $('tmTurns');
  return node ? node.textContent : '0';
}

function paintRail() {
  var orb = orbState();
  var words = STATE_WORDS[orb] || STATE_WORDS.idle;

  $('stateBig').textContent = words[0];
  $('stateShort').textContent = STATE_SHORT[orb] || STATE_SHORT.idle;
  // The state strip: the word, and under it the turns so far; the sentence
  // that explains the state rides along as its tooltip.
  $('stateSub').textContent = turnCount() + ' tahů';
  $('stateBig').title = words[1];

  $('listeningStrip').hidden = !state.listening;
  $('micLabel').textContent = state.listening ? 'Stop' : 'Mluvit';
  $('mic').setAttribute('aria-pressed', String(state.listening));

  var next = nextUp();
  $('nextTitle').textContent = next ? next.title : 'Nic dalšího dnes';
  // "… · 3 úkoly na dnes" (Kacey Phone 2a).
  var n = taskSummary().due;
  var due = n ? ' · ' + n + ' ' + (n === 1 ? 'úkol' : n < 5 ? 'úkoly' : 'úkolů') + ' na dnes' : '';
  $('nextMeta').textContent = (next ? next.meta : 'Kalendář je na dnešek prázdný.') + due;
  $('askNext').disabled = !next;
  if ($('askNextM')) $('askNextM').disabled = !next;
  // The phone's task dock talks too: its button mirrors this one.
  if ($('taskMicLabel')) {
    $('taskMicLabel').textContent = state.listening ? 'Stop' : 'Mluvit';
    $('taskMic').setAttribute('aria-pressed', String(state.listening));
  }
}

export function initMain() {
  /* On a phone the Today and Tasks panels fold away under "next up"; this
     opens them. On desktop they are always there and the toggle is hidden. */
  $('todayToggle').addEventListener('click', function () {
    var view = document.querySelector('.view[data-view="main"]');
    var open = view.getAttribute('data-today') !== 'open';
    view.setAttribute('data-today', open ? 'open' : '');
    $('todayToggle').setAttribute('aria-expanded', String(open));
    $('todayToggleLabel').textContent = open ? 'Skrýt' : 'Dnes ▾';
  });

  function askNext() {
    var next = nextUp();
    if (!next) return;
    go('main');
    submit('Co potřebuju na "' + next.title + '"?');
  }
  $('askNext').addEventListener('click', askNext);
  if ($('askNextM')) $('askNextM').addEventListener('click', askNext);

  /* The rail follows the orb, exactly like the telemetry rails did: one
     subscription, and it cannot drift from the state everything else reads. */
  bus.on('orb', paintRail);
  store.onChange(paintRail);         // the task count under "next up"
  paintRail();
  paintDate();

  /* The clock (core/clock.js): back from the background, "next up" may have
     passed; a new day also reloads the app document (reloadForDay) and says
     so, once, in a toast. */
  bus.on('clock', function () {
    paintDate(); paintRail();
    if (owed) reloadForDay();
  });
  setInterval(function () { if (owed) reloadForDay(); }, 60000);
  bus.on('day', function (d) {
    paintDate();
    var day = 'Nový den — ' + dayWords(d.to) + '.';
    reloadForDay().then(function (fresh) {
      if (fresh === true) say(day + ' Přehled jsem obnovila.');
      else if (fresh === false) say(day + ' Jsem offline — přehled obnovím, až se připojím.');
      else say(day);   // edits still saving: the reload follows once they are out
    });
  });
}
