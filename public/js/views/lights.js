/* =========================================================================
   THE LIGHTS.

   Light control is not part of Kacey. lightsd is its own app on the home
   server, on its own port, with its own schedule, effects and bulbs — this
   view frames it and links to it. The one exception is "Vypnout vše" above
   the frame: every lamp off in one press, through POST /api/lights/off (the
   server asks lightsd, lamp by lamp). It then reloads the frame and tells the
   header chip, so both show the dark room at once.

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

/* ---- Vypnout vše ---- */

var lit = null;             // lamps lit, from /api/lights/state; null = not known
var busy = false;
var failed = '';            // the last press's error, shown until the next answer

// 1 světlo · 2 světla · 5 světel
function lamps(n) {
  return n + ' ' + (n === 1 ? 'světlo' : n >= 2 && n <= 4 ? 'světla' : 'světel');
}

function paintAll() {
  var box = $('lightsAll');
  var dark = lit === 0;
  box.classList.toggle('is-dark', dark);
  $('lightsAllTitle').textContent = busy ? 'Zhasínám…'
    : lit === null ? 'Světla v místnostech'
    : dark ? 'Všechno je zhasnuté'
    : 'Svítí ' + lamps(lit);
  var note = $('lightsAllNote');
  note.classList.toggle('is-err', !!failed);
  note.textContent = failed ? failed + ' Světla zůstala, jak byla.'
    : dark ? 'Žádná lampa nesvítí.'
    : 'Jedním stiskem zhasneš všechny lampy ve všech místnostech.';
  var btn = $('lightsAllOff');
  btn.disabled = busy || dark;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  $('lightsAllLabel').textContent = busy ? 'Vypínám…' : failed ? 'Zkusit znovu' : 'Vypnout vše';
}

function loadState() {
  if (busy) return;
  fetch('/api/lights/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (st) { lit = st && st.ok && typeof st.lit === 'number' ? st.lit : null; })
    .catch(function () { lit = null; })
    .finally(paintAll);
}

function allOff() {
  if (busy) return;
  busy = true;
  failed = '';
  paintAll();
  fetch('/api/lights/off', { method: 'POST' })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error(b.error || 'lightsd neodpovídá');
        return b;
      });
    })
    .then(function (b) {
      lit = typeof b.lit === 'number' ? b.lit : 0;
      say(b.off ? 'Vypnuto ' + lamps(b.off) + '.' : 'Zhasnuto.');
      // lightsd's page and the header chip: show the dark room now, not at their next poll.
      var frame = $('lightsFrame');
      try { frame.contentWindow.location.reload(); }
      catch (e) { if (frame.getAttribute('src')) frame.setAttribute('src', lightsUrl()); }
      bus.emit('lights:changed');
    })
    .catch(function (err) {
      failed = String(err.message || err).replace(/\s*\(.*\)$/, '') + '.';   // "lightsd neodpovídá."
    })
    .finally(function () { busy = false; paintAll(); });
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
  setInterval(function () {
    if (currentView() === 'lights' && !document.hidden && enabled() && reachable) loadState();
  }, STATE_POLL_MS);
  store.onChange(function () { if (currentView() === 'lights') render(); });
}
