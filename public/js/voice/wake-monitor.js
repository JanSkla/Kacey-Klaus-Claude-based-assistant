/* =========================================================================
   WAKE WORD TEST MONITOR — the Controller's live view of the wake listener.

   While the Controller is on screen the wake listener runs as a test bench:
   every sound it cuts out of the room is logged with its score against the
   threshold, a match chimes and flashes, and dictation is NOT started — so
   "KC" can be said again and again and the numbers read off.

   wake.js (the transcript path) and wake-panel.js (the voice path) report
   here; this module only draws.
   ========================================================================= */

import { $ } from '../core/dom.js';
import { currentView } from '../ui/router.js';

var MAX_ROWS = 14;
var flashTimer = 0;

/** True while the Controller is showing: the wake listener is a test bench then. */
export function monitorOn() {
  return currentView() === 'controller' && !document.hidden && !!$('wakeMon');
}

export function monitorLevel(v) {
  if (!monitorOn()) return;
  var fill = $('wmLevel');
  if (fill) fill.style.width = Math.round(v * 100) + '%';
}

/** Which engine is listening, or why none is. */
export function monitorEngine(text) {
  var el = $('wmEngine');
  if (el && el.textContent !== text) el.textContent = text;
}

function hhmmss(d) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
}

/** One line in the log. kind: 'hit' | 'miss' | 'quiet' | 'heard'. */
export function monitorLog(kind, text) {
  if (!monitorOn()) return;
  var log = $('wmLog');
  if (!log) return;
  var empty = log.querySelector('.wakemon__empty');
  if (empty) empty.remove();

  var row = document.createElement('li');
  row.className = 'wakemon__row';
  row.setAttribute('data-kind', kind);
  var time = document.createElement('time');
  time.textContent = hhmmss(new Date());
  var what = document.createElement('span');
  what.textContent = text;
  row.appendChild(time);
  row.appendChild(what);
  log.insertBefore(row, log.firstChild);
  while (log.children.length > MAX_ROWS) log.removeChild(log.lastChild);

  if (kind === 'hit') {
    var box = $('wakeMon');
    box.setAttribute('data-hit', 'true');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { box.removeAttribute('data-hit'); }, 900);
  }
}

/** A voice-engine segment, as wake-voice.js scored it. */
export function monitorScore(info) {
  var len = (info.ms / 1000).toFixed(2) + ' s';
  if (info.quiet) {
    monitorLog('quiet', len + ' · moc tiché vůči místnosti (+' + Math.round(info.over) + ' dB, potřeba +8)');
    return;
  }
  var score = isFinite(info.score) ? info.score.toFixed(2) : 'mimo rozsah';
  var line = len + ' · ' + score + ' / práh ' + (info.threshold || 0).toFixed(2);
  if (!info.hit && isFinite(info.score) && info.score <= info.threshold) line += ' · shoda, ale hned po předchozí';
  monitorLog(info.hit ? 'hit' : 'miss', info.hit ? '„KC“ poznáno · ' + line : line);
}
