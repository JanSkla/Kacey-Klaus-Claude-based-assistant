/* =========================================================================
   THEME — one hue drives the whole interface, and the sheet that sets it.

   Everything visible is derived from a single CSS custom property, so the whole
   look is one number. That number is persisted, overridable per-load with
   ?hue=, and reachable by keyboard as well as by dragging the dial.
   ========================================================================= */

import { LS_HUE } from '../core/state.js';
import { $ } from '../core/dom.js';

var DEFAULT_HUE = 193;
var hue = DEFAULT_HUE;

var hueRing = $('hueRing'), hueKnob = $('hueKnob'), hueValue = $('hueValue');
var sheet = $('settingsPanel'), settingsBtn = $('settings'), settingsClose = $('settingsClose');

/* The alert hue sits opposite the chosen one. If the user picks a hue close
   to the default red-family alert, that would make errors look like ordinary
   readings — so it is pushed to the far side instead. */
function dangerHueFor(h) {
  var preferred = 352;                       // red reads as "alert" everywhere
  var d = Math.abs(h - preferred);
  d = Math.min(d, 360 - d);                  // shortest way round the wheel
  // Keep red unless the chosen hue is itself red-adjacent, in which case an
  // alert would be indistinguishable from every other reading.
  return d < 45 ? (h + 165) % 360 : preferred;
}

function applyHue(h, persist) {
  hue = ((Math.round(h) % 360) + 360) % 360;
  var root = document.documentElement;
  root.style.setProperty('--h', String(hue));
  root.style.setProperty('--h-danger', String(dangerHueFor(hue)));

  if (hueKnob) hueKnob.style.transform = 'rotate(' + hue + 'deg) translateY(-75px)';
  if (hueValue) hueValue.textContent = String(hue);
  if (hueRing) {
    hueRing.setAttribute('aria-valuenow', String(hue));
    hueRing.setAttribute('aria-valuetext', 'odstín ' + hue);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
    if (Number(b.dataset.h) === hue) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  // keep the browser UI (address bar on mobile) in step with the theme
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', 'hsl(' + hue + ' 62% 3%)');

  if (persist) { try { localStorage.setItem(LS_HUE, String(hue)); } catch (e) {} }
}

/* The knob sits at translateY(-75px) after rotate(hue), i.e. hue 0 points up.
   Convert a pointer position to the same convention. */
function angleFromEvent(ev) {
  var r = hueRing.getBoundingClientRect();
  var dx = ev.clientX - (r.left + r.width / 2);
  var dy = ev.clientY - (r.top + r.height / 2);
  return (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
}

function openSettings(open) {
  if (!sheet) return;
  sheet.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open && hueRing) hueRing.focus();
  else if (settingsBtn) settingsBtn.focus();
}

/* ---- wiring ------------------------------------------------------------
   Called once from app.js: restore, wire, paint. Order matters — the dial has
   to be showing the hue that is actually applied. */

export function initTheme() {
  if (hueRing) {
    var dragging = false;

    hueRing.addEventListener('pointerdown', function (ev) {
      dragging = true;
      hueRing.setPointerCapture(ev.pointerId);
      applyHue(angleFromEvent(ev), false);
      ev.preventDefault();
    });
    hueRing.addEventListener('pointermove', function (ev) {
      if (dragging) applyHue(angleFromEvent(ev), false);
    });
    hueRing.addEventListener('pointerup', function (ev) {
      if (!dragging) return;
      dragging = false;
      try { hueRing.releasePointerCapture(ev.pointerId); } catch (e) {}
      applyHue(hue, true);                       // commit once, not on every move
    });
    hueRing.addEventListener('pointercancel', function () {
      dragging = false; applyHue(hue, true);
    });

    hueRing.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { applyHue(hue + step, true); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { applyHue(hue - step, true); ev.preventDefault(); }
      else if (ev.key === 'Home') { applyHue(DEFAULT_HUE, true); ev.preventDefault(); }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (b) {
    b.addEventListener('click', function () { applyHue(Number(b.dataset.h), true); });
  });

  if (settingsBtn) settingsBtn.addEventListener('click', function () { openSettings(sheet.hidden); });
  if (settingsClose) settingsClose.addEventListener('click', function () { openSettings(false); });
  if (sheet) {
    sheet.addEventListener('click', function (ev) {
      if (ev.target === sheet) openSettings(false);        // click the backdrop
    });
  }
  /* Capture phase: Escape must close the panel instead of reaching the
     interrupt handler registered on document. */
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && sheet && !sheet.hidden) {
      openSettings(false);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);

  try {
    var savedHue = parseInt(localStorage.getItem(LS_HUE), 10);
    if (!isNaN(savedHue)) hue = savedHue;
  } catch (e) { /* private mode */ }
  // ?hue=<0-359> overrides for this load only — handy for screenshots and for
  // sharing a look without touching someone else's saved preference.
  var hueParam = /[?&]hue=(\d{1,3})/.exec(location.search);
  if (hueParam) hue = Number(hueParam[1]);
  applyHue(hue, false);
  // ?openSettings=1 opens the dial on load, so a headless browser can capture it.
  if (/[?&]openSettings=1/.test(location.search)) openSettings(true);
}
