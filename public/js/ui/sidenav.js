/* =========================================================================
   The desktop sidebar's badges and the header's lights chip.

   The sidebar itself is markup (index.html, `nav.sidenav`) and router.js
   marks the current item; this keeps the small numbers beside two of them:
   the date on Kalendář, the open tasks for today on Úkoly.

   The lights chip shows what the room light is doing, from GET
   /api/lights/state — Kacey reads lightsd there and never writes to it. The
   chip itself is a [data-go="lights"] button: changing the light happens in
   lightsd's own page, framed by the Lights view. When lightsd does not answer
   (or the source is switched off in the Controller), the chip hides.
   ========================================================================= */

import { $ } from '../core/dom.js';
import * as store from '../core/store.js';
import { bucketOf } from '../core/due.js';
import { onEnter } from './router.js';

var LIGHTS_POLL_MS = 30000;

function paintBadges() {
  var cal = $('navBadgeCal');
  if (cal) cal.textContent = String(new Date().getDate());
  var open = (store.data.tasks || []).filter(function (t) {
    var b = bucketOf(t);
    return !t.done && (b === 'today' || b === 'overdue');
  }).length;
  var badge = $('navBadgeTasks');
  if (badge) badge.textContent = open ? String(open) : '';
}

function lightsEnabled() {
  return ((store.data.settings || {}).sources || {}).lights !== false;
}

function paintLights(st) {
  var chip = $('lightChip');
  if (!chip) return;
  if (!st || !st.ok || !st.known || !lightsEnabled()) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('is-on', !!st.on);
  var mode = st.mode === 'white' ? 'bílá' : st.mode ? 'barva' : '';
  $('lightChipLabel').textContent = st.on ? st.brightness + ' %' + (mode ? ' · ' + mode : '') : 'vypnuto';
  // The phone's chip says only the brightness (Kacey Phone).
  if ($('lightChipShort')) $('lightChipShort').textContent = st.on ? st.brightness + ' %' : 'vyp.';
  chip.setAttribute('aria-label', 'Světla · ' + (st.on ? st.brightness + ' %' + (mode ? ', ' + mode : '') : 'vypnuto'));
  $('lightChipSw').style.background = st.on && st.css ? st.css : '';
  chip.title = 'Světla — ' + (st.name || 'lampa') + ' · ' + (st.on ? st.brightness + ' %' : 'vypnuto') + ' · otevřít ovládání';
}

function loadLights() {
  if (!$('lightChip')) return;
  if (!lightsEnabled()) { paintLights(null); return; }
  fetch('/api/lights/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(paintLights)
    .catch(function () { paintLights(null); });
}

export function initSidenav() {
  paintBadges();
  // A task ticked off changes the count; the lights source switched off hides the chip.
  store.onChange(function () { paintBadges(); if (!lightsEnabled()) paintLights(null); });
  setInterval(paintBadges, 60000);

  loadLights();
  setInterval(function () { if (!document.hidden) loadLights(); }, LIGHTS_POLL_MS);
  onEnter('lights', loadLights);
  // Back from lightsd's page, the light has probably just changed.
  onEnter('main', loadLights);
}
