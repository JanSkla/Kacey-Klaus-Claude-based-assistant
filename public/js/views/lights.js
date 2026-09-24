/* =========================================================================
   THE LIGHTS.

   Light control is not part of Kacey. lightsd is its own app on the home
   server, on its own port, with its own schedule, effects and bulbs — this
   view only frames it and links to it. Nothing here talks to a bulb, and
   nothing in Kacey's server proxies it.

   It lives on the same host as Kacey, so the address is this page's host on
   lightsd's port. The iframe is only loaded the first time the view opens:
   a hidden frame polling bulbs in the background is not something a chat
   window should be doing.

   The "Světla v místnosti" switch in the controller is what turns this off.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as store from '../core/store.js';
import { onEnter, currentView } from '../ui/router.js';

var LIGHTS_PORT = 8080;

export function lightsUrl() {
  return location.protocol + '//' + (location.hostname || 'localhost') + ':' + LIGHTS_PORT;
}

function enabled() {
  return (store.data.settings.sources || {}).lights !== false;
}

var reachable = null;       // null = not asked yet

/* An iframe cannot say it failed to load — a dead port just paints the
   browser's blank error page. So ask first: a no-cors fetch cannot read the
   answer, but it does reject when nothing is listening, which is the only
   question here. */
function probe() {
  reachable = null;
  fetch(lightsUrl(), { mode: 'no-cors', cache: 'no-store' })
    .then(function () { reachable = true; })
    .catch(function () { reachable = false; })
    .finally(render);
}

function render() {
  var frame = $('lightsFrame');
  var on = enabled();
  $('lightsOff').hidden = on;
  $('lightsDown').hidden = !on || reachable !== false;
  frame.hidden = !on || reachable !== true;
  if (on && reachable === null) return;               // still asking
  if (on && reachable && !frame.getAttribute('src')) frame.setAttribute('src', lightsUrl());
  // Switched off while loaded: drop the page rather than leave it running.
  if (!on && frame.getAttribute('src')) frame.removeAttribute('src');
}

export function initLights() {
  if (!$('lightsFrame')) return;
  var url = lightsUrl();
  $('lightsOpen').href = url;
  $('lightsWhere').textContent = 'samostatná aplikace · lightsd na ' + url.replace(/^https?:\/\//, '');

  $('lightsRetry').addEventListener('click', probe);
  onEnter('lights', function () { if (reachable !== true) probe(); else render(); });
  store.onChange(function () { if (currentView() === 'lights') render(); });
}
