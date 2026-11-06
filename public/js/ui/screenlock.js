/* =========================================================================
   THE SCREEN LOCK — the square button in the header.

   Pressed, the bedside panel never goes dark on its own: the three-minute
   idle timeout (Controller → Noc a ráno → Uspání obrazovky) is off and the
   screen stays lit until the button is pressed again. Released, the timeout
   starts from now — three minutes of nothing, the last fifteen seconds
   dimming, then dark.

   The state lives on the server (screen.js, /api/screen/lock), not here: the
   kiosk and the desktop show the same button, and the bedside panel is one
   screen whoever asked. Every change is broadcast as a `screen_lock` frame,
   so a second page follows without being asked.

   The vinyl on the whole screen holds the panel lit on its own
   (views/miniplayer.js) — that is not this button and does not light it up.
   ========================================================================= */

import * as bus from '../core/bus.js';
import { $ } from '../core/dom.js';

var locked = false;

function render() {
  var btn = $('screenLock');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(locked));
  btn.setAttribute('aria-label', locked ? 'Obrazovka je vždy zapnutá — vypnout zámek' : 'Nechat obrazovku vždy zapnutou');
  btn.title = locked
    ? 'Obrazovka vždy zapnutá — klepnutím ji zase nechat zhasnout'
    : 'Obrazovka zhasne po nečinnosti — klepnutím ji nechat vždy zapnutou';
  /* One icon, two shackles: open while the screen may go dark, shut while it
     may not. `hidden` is an HTML attribute — an SVG group is switched by its
     own display instead. */
  $('screenLockOpen').style.display = locked ? 'none' : '';
  $('screenLockShut').style.display = locked ? '' : 'none';
}

function read() {
  fetch('/api/screen/lock').then(function (r) { return r.json(); })
    .then(function (d) { locked = !!d.lock; render(); })
    .catch(function () { /* the server's answer; the button stays as it is */ });
}

function set(on) {
  locked = on;                       // answer the press at once, confirm below
  render();
  fetch('/api/screen/lock', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: on }),
  }).then(function (r) { return r.json(); })
    .then(function (d) { locked = !!d.lock; render(); })
    .catch(function () { read(); });
}

export function initScreenLock() {
  var btn = $('screenLock');
  if (!btn) return;
  btn.addEventListener('click', function () { set(!locked); });
  // Another page pressed it (server.js broadcasts every change).
  bus.on('screen_lock', function (msg) { locked = !!msg.on; render(); });
  render();
  read();
}
