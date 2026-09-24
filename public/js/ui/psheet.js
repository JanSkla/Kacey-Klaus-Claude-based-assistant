/* =========================================================================
   Phone sheets.

   On a phone some panels that sit beside the content on desktop — the
   calendar's sources, the event editor, the journal's side chat — become
   sheets that slide up from the bottom over a scrim. They are the same
   elements in the same place in the document; `.is-psheet-open` is what the
   phone stylesheet turns into a sheet, and on desktop it does nothing.

   One at a time. The scrim, Escape and any [data-psheet-close] inside the
   sheet all close it.
   ========================================================================= */

import { $ } from '../core/dom.js';

var current = null;        // { el, onClose }

export function isPhone() {
  return window.matchMedia('(max-width: 760px)').matches;
}

export function openSheet(el, onClose) {
  closeSheet();
  current = { el: el, onClose: onClose || null };
  el.classList.add('is-psheet-open');
  $('scrim').hidden = false;
}

export function closeSheet() {
  if (!current) return;
  var c = current;
  current = null;
  c.el.classList.remove('is-psheet-open');
  $('scrim').hidden = true;
  if (c.onClose) c.onClose();
}

export function sheetOpen(el) { return !!current && (!el || current.el === el); }

export function initSheets() {
  $('scrim').addEventListener('click', closeSheet);
  document.addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('[data-psheet-close]')) closeSheet();
  });
  // Capture phase, like the modal sheets: Escape closes this before it can
  // reach the interrupt handler on document.
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && current) {
      closeSheet();
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
  }, true);
  // Rotating to landscape or widening the window leaves no sheet to be in.
  window.matchMedia('(max-width: 760px)').addEventListener('change', function (m) {
    if (!m.matches) closeSheet();
  });
}
