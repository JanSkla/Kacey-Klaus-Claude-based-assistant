/* =========================================================================
   THE LIGHTS.

   Light control is not part of Kacey. lightsd is its own app on the home
   server, on its own port, with its own schedule, effects and bulbs — this
   view only frames it and links to it. Nothing here talks to a bulb.

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
  if (on && reachable === null) return;               // still asking
  if (on && reachable && !frame.getAttribute('src')) frame.setAttribute('src', lightsUrl());
  // Switched off while loaded: drop the page rather than leave it running.
  if (!on && frame.getAttribute('src')) frame.removeAttribute('src');
}

export function initLights() {
  if (!$('lightsFrame')) return;
  var url = lightsUrl();
  $('lightsOpen').href = url;
  // The Víc sheet's row says where it goes.
  if ($('moreLightsMeta')) $('moreLightsMeta').textContent = 'lightsd přes Kacey';
  $('lightsWhere').textContent = 'samostatná aplikace · lightsd přes ' + url.replace(/^https?:\/\//, '');

  $('lightsRetry').addEventListener('click', probe);
  onEnter('lights', function () { if (reachable !== true) probe(); else render(); });
  store.onChange(function () { if (currentView() === 'lights') render(); });
}
