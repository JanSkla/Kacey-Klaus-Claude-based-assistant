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
  $('stateSub').textContent = orb === 'idle'
    ? words[1] + ' ' + turnCount() + ' tahů v téhle relaci.'
    : words[1];

  $('listeningStrip').hidden = !state.listening;
  $('micLabel').textContent = state.listening ? 'Stop' : 'Mluvit';
  $('mic').setAttribute('aria-pressed', String(state.listening));

  var next = nextUp();
  $('nextTitle').textContent = next ? next.title : 'Nic dalšího dnes';
  $('nextMeta').textContent = next ? next.meta : 'Kalendář je na dnešek prázdný.';
  $('askNext').disabled = !next;
}

export function initMain() {
  $('askNext').addEventListener('click', function () {
    var next = nextUp();
    if (!next) return;
    go('main');
    submit('Co potřebuju na "' + next.title + '"?');
  });

  /* The rail follows the orb, exactly like the telemetry rails did: one
     subscription, and it cannot drift from the state everything else reads. */
  bus.on('orb', paintRail);
  paintRail();
}
