/* =========================================================================
   THE NIGHT VIEW — the wake word from bed (Claude Design 5c / 5d).

   At night the wake word is a question, not getting up: the server keeps the
   sleep state and sets `sleep.night_wake` (sleep.js). While that is set the
   page shows only this — what was asked, what Kacey said, "Zpět spát" — dim,
   no panels, no filled accent. After 20 s of quiet, or on "Zpět spát", the
   server turns the screen off; the night run is not touched.

   Taps in here are not interactions (activity.js skips `.nightview`): getting
   up is a tap anywhere else, or the screen going dark and a tap after.
   ========================================================================= */

import { el } from '../core/el.js';
import { state } from '../core/state.js';
import { night, onNight } from '../net/nightapi.js';
import { startRecognition } from '../voice/recognition.js';

var QUIET_S = 20;

var root = null, refs = {}, quiet = 0, ticker = null, sent = false;

function hm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

/* The last thing asked and the last reply, read off the chat log, so this
   view needs no second copy of the conversation. */
function lastLines() {
  var log = document.getElementById('log');
  var pick = function (role) {
    var rows = log ? log.querySelectorAll('.msg--' + role + ' .msg__bubble') : [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var text = rows[i].textContent.trim();
      if (text) return text;
    }
    return '';
  };
  return { you: pick('user'), kacey: pick('assistant') };
}

function build() {
  refs.clock = el('span.nightview__clock');
  refs.you = el('p.nightview__said');
  refs.kacey = el('p.nightview__reply');
  root = el('div.nightview#nightView', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Noc', hidden: true }, [
    el('div.nightview__bar', [
      el('span.nightview__mark', { 'aria-hidden': 'true' }),
      el('span.nightview__dot', { 'aria-hidden': 'true' }),
      el('span.nightview__state', [el('span.nightview__long', 'Noc · poslouchám'), el('span.nightview__short', 'Noc')]),
      refs.clock
    ]),
    el('div.nightview__body', [
      el('p.nightview__who', 'ty'), refs.you,
      el('p.nightview__who.nightview__who--kacey', 'Kacey'), refs.kacey,
      el('div.nightview__acts', [
        el('button.nightview__sleep', { type: 'button', onclick: backToSleep }, 'Zpět spát'),
        el('button.nightview__more', { type: 'button', onclick: oneMore }, 'Ještě něco')
      ])
    ])
  ]);
  document.body.appendChild(root);
}

function paint() {
  var l = lastLines();
  refs.clock.textContent = hm(new Date());
  refs.you.textContent = l.you || '…';
  refs.kacey.textContent = l.kacey || '…';
  refs.kacey.hidden = !l.kacey;
}

function busy() { return state.streaming || state.listening || state.micDesired || state.ttsPending > 0; }

function tick() {
  paint();
  quiet = busy() ? 0 : quiet + 1;
  if (quiet >= QUIET_S) backToSleep();
}

function backToSleep() {
  if (sent) return;
  sent = true;
  fetch('/api/night/back-to-sleep', { method: 'POST' }).catch(function () { sent = false; });
}

function oneMore() {
  quiet = 0;
  state.micDesired = true;
  startRecognition();
}

function follow() {
  var s = night.state && night.state.sleep;
  var on = !!(s && s.night_wake);
  document.documentElement.classList.toggle('is-nightwake', on);
  if (on === !root.hidden) return;
  root.hidden = !on;
  clearInterval(ticker);
  if (on) {
    quiet = 0; sent = false;
    paint();
    ticker = setInterval(tick, 1000);
  }
}

export function initNightView() {
  build();
  onNight(function (what) { if (what === 'state') follow(); });
}
