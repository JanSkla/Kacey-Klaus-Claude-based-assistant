/* =========================================================================
   THE LIGHTS.

   Light control is not part of Kacey. lightsd is its own app on the home
   server, on its own port, with its own schedule, effects and bulbs — this
   view frames it and links to it. The one exception is "Vypnout vše" above
   the frame: every lamp off in one press, through POST /api/lights/off (the
   server asks lightsd for every lamp at once, lightsoff.js). It then reloads
   the frame and tells the header chip, so both show the dark room at once.
   When Kacey does it by voice (app_lights) or another page does, a `lights`
   frame arrives and the same happens here.

   Kacey's server passes /lights/ through to lightsd (frameproxy.js), so the
   page is on this origin: over the https address on a phone or a remote
   laptop, lightsd's own port would be refused (no TLS there, or not reachable
   at all). The iframe is only loaded the first time the view opens:
   a hidden frame polling bulbs in the background is not something a chat
   window should be doing.

   The "Světla v místnosti" switch in the controller is what turns this off.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as store from '../core/store.js';
import { onEnter, currentView } from '../ui/router.js';
import { say } from '../ui/toast.js';
import * as bus from '../core/bus.js';

var STATE_POLL_MS = 5000;   // while the view shows: lamps also change in lightsd's page

export function lightsUrl() {
  return location.origin + '/lights/';
}

function enabled() {
  return (store.data.settings.sources || {}).lights !== false;
}

var reachable = null;       // null = not asked yet

/* An iframe cannot say it failed to load. So ask first: Kacey answers 503
   under /lights/ while lightsd does not. */
function probe() {
  reachable = null;
  fetch(lightsUrl(), { cache: 'no-store' })
    .then(function (r) { reachable = r.status !== 503; })
    .catch(function () { reachable = false; })
    .finally(render);
}

function render() {
  var frame = $('lightsFrame');
  var on = enabled();
  $('lightsOff').hidden = on;
  $('lightsDown').hidden = !on || reachable !== false;
  frame.hidden = !on || reachable !== true;
  $('lightsAll').hidden = frame.hidden;
  if (on && reachable === null) return;               // still asking
  if (on && reachable && !frame.getAttribute('src')) frame.setAttribute('src', lightsUrl());
  // Switched off while loaded: drop the page rather than leave it running.
  if (!on && frame.getAttribute('src')) frame.removeAttribute('src');
}

/* ---- Vypnout vše ----
   The strip's states, in the order paintAll() picks them: offline (the
   button waits), busy, the last press failed (err), some lamps stayed lit
   (warn, named), lightsd has no lamps (empty), dark, lit, not known. */

var ORIGIN = Math.random().toString(36).slice(2, 10);   // this page: its own `lights` frame is skipped
var lit = null;             // lamps lit, from /api/lights/state; null = not known
var total = null;           // lamps lightsd knows
var lastOff = null;         // the last "Vypnout vše" { at, by }, from the server
var busy = false;
var failed = '';            // the last press's error, shown until the next answer
var still = [];             // lamps that stayed lit after the last press, by name

// 1 světlo · 2 světla · 5 světel
function lamps(n) {
  return n + ' ' + (n === 1 ? 'světlo' : n >= 2 && n <= 4 ? 'světla' : 'světel');
}

// " · zhasnuto dnes, 23:10 (Kacey)" — only for today; older is not news.
function lastWords() {
  if (!lastOff || !lastOff.at) return '';
  var d = new Date(lastOff.at);
  if (d.toDateString() !== new Date().toDateString()) return '';
  return ' · zhasnuto dnes, ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') +
    (lastOff.by === 'kacey' ? ' (Kacey)' : '');
}

function paintAll() {
  var box = $('lightsAll');
  var offline = !navigator.onLine;
  var empty = total === 0;
  var dark = lit === 0;
  box.classList.toggle('is-dark', !busy && (dark || empty));
  $('lightsAllTitle').textContent = busy ? 'Zhasínám…'
    : empty ? 'Žádná lampa'
    : lit === null ? 'Světla v místnostech'
    : dark ? 'Všechno je zhasnuté'
    : 'Svítí ' + lamps(lit) + (total > lit ? ' z ' + total : '');
  var note = $('lightsAllNote');
  var tone = offline || still.length ? 'warn' : failed ? 'err' : '';
  note.classList.toggle('is-err', tone === 'err');
  note.classList.toggle('is-warn', tone === 'warn');
  note.textContent = offline ? 'Jsi offline — zhasnout půjde, až se připojím.'
    : failed ? failed + ' Světla zůstala, jak byla.'
    : still.length ? 'Nezhaslo: ' + still.join(', ') + '. Zkus to znovu, nebo v lightsd níž.'
    : empty ? 'lightsd zatím nemá žádnou lampu — není co zhasínat.'
    : dark ? 'Žádná lampa nesvítí' + lastWords() + '.'
    : lit === null ? 'Nevím, co právě svítí — zhasnout jde i tak.'
    : 'Jedním stiskem zhasneš všechny lampy ve všech místnostech.';
  var btn = $('lightsAllOff');
  btn.disabled = busy || offline || empty || dark;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  $('lightsAllLabel').textContent = busy ? 'Vypínám…' : failed || still.length ? 'Zkusit znovu' : 'Vypnout vše';
}

function take(st) {
  lit = typeof st.lit === 'number' ? st.lit : null;
  total = typeof st.total === 'number' ? st.total : null;
  if ('all_off' in st) lastOff = st.all_off;
  else if (st.last) lastOff = st.last;
  // A lamp named as stuck that is dark now (switched in lightsd's page) is no longer news.
  if (lit === 0) still = [];
}

function loadState() {
  if (busy) return;
  fetch('/api/lights/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (st) { if (st && st.ok) take(st); else lit = total = null; })
    .catch(function () { lit = total = null; })
    .finally(paintAll);
}

// lightsd's page and the header chip: show the dark room now, not at their next poll.
function showDark() {
  var frame = $('lightsFrame');
  if (frame.getAttribute('src')) {
    try { frame.contentWindow.location.reload(); }
    catch (e) { frame.setAttribute('src', lightsUrl()); }
  }
  bus.emit('lights:changed');
}

function allOff() {
  if (busy || !navigator.onLine) return;
  busy = true;
  failed = '';
  still = [];
  paintAll();
  fetch('/api/lights/off', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: ORIGIN }),
  })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || 'Server neodpovídá');
        return b;
      });
    })
    .then(function (b) {
      if (b.preview) { say('Náhled vylepšení — světla zůstala, jak byla.'); return; }
      take(b);
      still = b.still || [];
      if (!b.total) return;
      say(b.lit ? 'Vypnuto ' + lamps(b.off) + ', ale pořád svítí ' + lamps(b.lit) + '.'
        : 'Zhasnuto — ' + (b.off === b.total ? 'všechna ' : '') + lamps(b.off) + '.');
      showDark();
    })
    .catch(function (err) {
      // "lightsd neodpovídá (fetch failed)" -> "lightsd neodpovídá."; a dropped connection is the server's.
      var msg = String(err.message || err);
      failed = (/^Failed to fetch|NetworkError|Load failed/.test(msg) ? 'Server neodpovídá' : msg.replace(/\s*\(.*\)$/, '')) + '.';
    })
    .finally(function () { busy = false; paintAll(); });
}

/* Another page — or Kacey, asked by voice — switched everything off. */
function heard(msg) {
  if (!msg || msg.event !== 'all_off' || msg.origin === ORIGIN || msg.preview) return;
  take(msg);
  still = msg.still || [];
  failed = '';
  if (currentView() === 'lights') { paintAll(); showDark(); }
}

export function initLights() {
  if (!$('lightsFrame')) return;
  var url = lightsUrl();
  $('lightsOpen').href = url;
  // The Víc sheet's row says where it goes.
  if ($('moreLightsMeta')) $('moreLightsMeta').textContent = 'lightsd přes Kacey';
  $('lightsWhere').textContent = 'samostatná aplikace · lightsd přes ' + url.replace(/^https?:\/\//, '');

  $('lightsRetry').addEventListener('click', probe);
  $('lightsAllOff').addEventListener('click', allOff);
  onEnter('lights', function () { if (reachable !== true) probe(); else render(); failed = ''; loadState(); });
  bus.on('lights', heard);
  window.addEventListener('offline', paintAll);
  window.addEventListener('online', function () { if (currentView() === 'lights') loadState(); else paintAll(); });
  setInterval(function () {
    if (currentView() === 'lights' && !document.hidden && enabled() && reachable) loadState();
  }, STATE_POLL_MS);
  store.onChange(function () { if (currentView() === 'lights') render(); });
}
